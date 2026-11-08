package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

// ---------- 房间 ----------

type Room struct {
	Key   string
	mu    sync.RWMutex
	peers map[string]*Peer
}

var (
	roomsMu sync.RWMutex
	rooms   = map[string]*Room{}
)

func getRoom(name string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	r, ok := rooms[name]
	if !ok {
		r = &Room{Key: name, peers: map[string]*Peer{}}
		rooms[name] = r
	}
	return r
}

// ---------- Peer ----------

type Peer struct {
	ID   string
	PC   *webrtc.PeerConnection
	Room *Room

	mu        sync.Mutex
	outTracks []*webrtc.TrackLocalStaticRTP
	subs      map[string]bool
	free      []*webrtc.RTPSender // 离开者腾出、可复用的 sender

	// 服务端 → 客户端 的推送通道（SSE）
	push chan []byte

	// 重新协商串行化：同一时刻只允许一个 offer 在途，避免 glare
	negMu    sync.Mutex
	needNeg  bool
	inFlight bool

	srvMuted  atomic.Bool
	closeOnce sync.Once
}

func toJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func (p *Peer) send(msg any) {
	select {
	case p.push <- toJSON(msg):
	default:
		log.Printf("[%s] push buffer full, drop %T", p.ID, msg)
	}
}

// renegotiate 生成新 offer 并推给客户端。
// 串行化：上一轮 offer 未完成时只置标记，等 answer 回来后再补发。
func (p *Peer) renegotiate() {
	p.negMu.Lock()
	if p.inFlight {
		p.needNeg = true
		p.negMu.Unlock()
		return
	}
	p.inFlight = true
	p.needNeg = false
	p.negMu.Unlock()
	p.doOffer()
}

func (p *Peer) doOffer() {
	if len(p.PC.GetTransceivers()) == 0 {
		// 服务端主动发 offer 时必须有 m-line
		if _, err := p.PC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv}); err != nil {
			log.Printf("[%s] AddTransceiver: %v", p.ID, err)
		}
	}
	if p.PC.SignalingState() != webrtc.SignalingStateStable {
		log.Printf("[%s] signaling=%s, 推迟协商", p.ID, p.PC.SignalingState())
		p.finishNegotiation()
		return
	}
	offer, err := p.PC.CreateOffer(nil)
	if err != nil {
		log.Printf("[%s] CreateOffer: %v", p.ID, err)
		p.finishNegotiation()
		return
	}
	// offer.SDP 在 CreateOffer 时就带 ice-ufrag/pwd；LocalDescription() 要等 SetLocal 之后才稳
	offerSDP := offer.SDP

	done := make(chan struct{})
	var once sync.Once
	closeDone := func() { once.Do(func() { close(done) }) }

	p.PC.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			log.Printf("[%s] candidate %s", p.ID, c.String())
			return
		}
		closeDone() // nil = gathering 结束
	})
	if err := p.PC.SetLocalDescription(offer); err != nil {
		log.Printf("[%s] SetLocalDescription: %v", p.ID, err)
		p.finishNegotiation()
		return
	}

	go func() {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		// 用 SetLocalDescription 之后的最新本地描述（含 candidates），但 ufrag 一定有
		local := p.PC.LocalDescription()
		if local != nil && strings.Contains(local.SDP, "ice-ufrag") {
			offerSDP = local.SDP
		} else if !strings.Contains(offerSDP, "ice-ufrag") {
			log.Printf("[%s] ERROR 两条路径都没有 ufrag", p.ID)
		}
		p.send(map[string]string{"type": "offer", "sdp": offerSDP})
		log.Printf("[%s] pushed offer ufrag=%v", p.ID, strings.Contains(offerSDP, "ice-ufrag"))
	}()
}

// onAnswerApplied 在客户端回 answer 后调用，若有积压的协商请求则继续
func (p *Peer) onAnswerApplied() {
	p.negMu.Lock()
	p.inFlight = false
	pending := p.needNeg
	p.needNeg = false
	p.negMu.Unlock()
	if pending {
		p.renegotiate()
	}
}

func (p *Peer) finishNegotiation() {
	p.negMu.Lock()
	p.inFlight = false
	pending := p.needNeg
	p.needNeg = false
	p.negMu.Unlock()
	if pending {
		p.renegotiate()
	}
}

// ---------- HTTP ----------

type signalReq struct {
	Room string `json:"room"`
	Peer string `json:"peer"`
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataPath := flag.String("data", "data/fong.json", "空间/房间/成员数据文件")
	flag.BoolVar(&allowLegacyRooms, "allow-legacy", false, "允许不属于任何空间的房间（仅调试用网页）")
	flag.BoolVar(&allowTestTraffic, "allow-test", false, "接受 X-Fong-Test 测试流量（仅本地测试服务）")
	webMPath := flag.String("webm", "", "手机版网页目录（默认取 -web 下的 m/）")
	dlPath := flag.String("dl", "", "客户端安装包目录（提供 /dl/ 下载与 /api/releases）")
	webPath := flag.String("web", "", "落地页目录（提供 GET /）")
	certFile := flag.String("cert", "", "TLS cert file (enables HTTPS)")
	keyFile := flag.String("key", "", "TLS key file")
	publicIP := flag.String("public-ip", "8.156.40.211", "服务器公网 IP（EIP 1:1 NAT 时必须设，映射为 host 候选）")
	flag.Parse()
	natPublicIP = *publicIP

	// 运维后台：只在设了 FONG_ADMIN_TOKEN 时可用
	initAdmin()

	// 安装包目录：没有就自动创建，方便部署
	if *dlPath != "" {
		if err := os.MkdirAll(*dlPath, 0o755); err != nil {
			log.Printf("创建下载目录 %s 失败: %v", *dlPath, err)
		} else {
			dlDir = *dlPath
			log.Printf("下载目录: %s", dlDir)
		}
	}
	if *webPath != "" {
		webDir = *webPath
		log.Printf("落地页目录: %s", webDir)
	}
	// 【0.4.67】/m/ 的目录：默认从 -web 推导，也可用 -webm 显式指定。
	// 原来写死相对路径 "web/m"，和 imgDir/fileDir 是同一个坑 ——
	// 解析基准是进程 cwd，换个启动目录就 404（回归测试就是撞这个）。
	mDir := *webMPath
	if mDir == "" && *webPath != "" {
		mDir = filepath.Join(*webPath, "m")
	}
	if mDir == "" {
		mDir = "web/m"
	}

	loadStore(*dataPath)

	// 【0.4.67】启动时把所有路径打一行日志。
	// 这 10 行能一次性消灭一类问题：cwd 被重置、目录不存在、备份漏目录 ——
	// 全都能在第一眼看到，而不是靠演练或事故发现。
	// 实测踩过两次：恢复演练时 sudo 重置 cwd 到 /root 导致图片 403；/m/ 写死相对路径导致 404。
	cwd, _ := os.Getwd()
	abs := func(p string) string {
		if p == "" {
			return "(未设置)"
		}
		if a, err := filepath.Abs(p); err == nil {
			return a
		}
		return p
	}
	log.Printf("[paths] cwd=%s", cwd)

	// 【0.4.69】版本 + 二进制自身的 size/mtime。
	// 起因：改完代码没重新构建，测试跑的是旧二进制，结果变好被误认为改动生效 ——
	// "验证的成本已经付了，只是付给了错的对象"，比没验证更危险，因为会建立错误信心。
	// 有了这行，go build + restart 之后第一眼就能确认跑的是不是刚构建那份，不用等测试反常才回头怀疑。
	if exe, err := os.Executable(); err == nil {
		if st, err := os.Stat(exe); err == nil {
			log.Printf("[build] %s  size=%d  mtime=%s", exe, st.Size(), st.ModTime().Format("2006-01-02 15:04:05"))
		}
	}
	log.Printf("[paths] data=%s  img=%s  file=%s", abs(*dataPath), abs(imgDir), abs(fileDir))
	log.Printf("[paths] web=%s  webm=%s  dl=%s", abs(webDir), abs(mDir), abs(dlDir))
	for _, d := range []string{filepath.Dir(*dataPath), imgDir, fileDir, mDir} {
		if _, err := os.Stat(d); err != nil {
			log.Printf("[paths] ⚠ 目录不存在: %s (%v)", abs(d), err)
		}
	}
	mux := http.NewServeMux()
	registerAPI(mux)
	// 【0.4.69】/healthz 带上构建指纹，一行 curl 就能确认线上跑的是哪次构建。
	// 不用登录、不用翻日志。
	buildInfo := "unknown"
	if exe, err := os.Executable(); err == nil {
		if st, err := os.Stat(exe); err == nil {
			buildInfo = fmt.Sprintf("%d@%s", st.Size(), st.ModTime().Format("01-02 15:04:05"))
		}
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok " + buildInfo))
	})
	mux.HandleFunc("/signal", handleSignal)
	mux.HandleFunc("/events", handleEvents)
	mux.HandleFunc("/answer", handleAnswer)
	// 手机端入口：/m/ 指向一个单文件移动端页面（不受 -web 落地页影响）。
	// 【0.4.11 热修】必须 no-store：这页改一版手机浏览器就拿不到，还一直用缓存里的旧页面
	mux.HandleFunc("/m/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.StripPrefix("/m/", http.FileServer(http.Dir(mDir))).ServeHTTP(w, r)
	})
	mux.Handle("/", http.FileServer(http.Dir(webDir)))

	if *certFile != "" && *keyFile != "" {
		log.Printf("FONG SFU (HTTPS) on %s", *addr)
		log.Fatal(http.ListenAndServeTLS(*addr, *certFile, *keyFile, withCORS(mux)))
	}
	log.Printf("FONG SFU (HTTP) on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, withCORS(mux)))
}

func handleSignal(w http.ResponseWriter, r *http.Request) {
	var req signalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Room == "" || req.Peer == "" || len(req.Peer) > 128 {
		writeErr(w, fail(400, "缺少 room/peer"))
		return
	}
	roomsMu.RLock()
	existing := rooms[req.Room]
	roomsMu.RUnlock()
	isNew := true
	if existing != nil {
		existing.mu.RLock()
		_, had := existing.peers[req.Peer]
		existing.mu.RUnlock()
		isNew = !had
	}
	if err := checkJoin(r, req.Room, req.Peer, isNew); err != nil {
		writeErr(w, err)
		return
	}
	room := getRoom(req.Room)

	// 【多开修复】同一个 uid 带新 peerId 进同一房间时，先踢掉旧 peer。
	// peerId 格式是 "uid.随机后缀"，每次进房后缀都变，所以同一账号第二次进房
	// 会被当成两个不同的人 → 服务端不踢旧连接 → 房间里出现两个同名成员、
	// 两路音频互相回声。这里按 uid 前缀清理同房间的旧 peer。
	uid := uidOfPeer(req.Peer)
	room.mu.Lock()
	var stale []*Peer
	for id, p := range room.peers {
		if id != req.Peer && uidOfPeer(id) == uid {
			stale = append(stale, p)
		}
	}
	room.mu.Unlock()
	for _, p := range stale {
		log.Printf("[%s] 同账号 %s 新连接进入，关闭旧 peer %s", req.Peer, uid[:8], p.ID)
		p.close("duplicate-login")
	}

	room.mu.Lock()
	peer, ok := room.peers[req.Peer]
	if ok && req.SDP != "" {
		// 同一 peer 重新发首轮 offer（断线重连）：旧连接作废，重新建
		old := peer
		room.mu.Unlock()
		old.close("")
		room.mu.Lock()
		ok = false
	}
	if !ok {
		p, err := newPeer(req.Peer, room)
		if err != nil {
			room.mu.Unlock()
			http.Error(w, err.Error(), 500)
			return
		}
		peer = p
		room.peers[req.Peer] = p
	}
	room.mu.Unlock()
	if !ok {
		go peer.watchServerMute()
		notifyRoomKey(req.Room)
	}

	if req.SDP == "" {
		// 纯登记
		room.subscribeTracksTo(peer, false)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"type": "ready"})
		go func() { time.Sleep(150 * time.Millisecond); peer.renegotiate() }()
		return
	}

	// 客户端首轮 offer（带 sendrecv，能收到它的麦）
	if err := peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: req.SDP,
	}); err != nil {
		log.Printf("[%s] SetRemoteDescription(offer): %v", req.Peer, err)
		http.Error(w, err.Error(), 500)
		return
	}
	// 把房间已有 track 塞进去（在 CreateAnswer 之前）
	room.subscribeTracksTo(peer, false)

	answer, err := peer.PC.CreateAnswer(nil)
	if err != nil {
		log.Printf("[%s] CreateAnswer: %v", req.Peer, err)
		http.Error(w, err.Error(), 500)
		return
	}
	// 必须在 SetLocalDescription 之前注册 gathering 完成通知
	done := webrtc.GatheringCompletePromise(peer.PC)
	if err := peer.PC.SetLocalDescription(answer); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	local := peer.PC.LocalDescription()
	sdp := answer.SDP
	if local != nil && strings.Contains(local.SDP, "ice-ufrag") {
		sdp = local.SDP
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"type": "answer", "sdp": sdp})
	log.Printf("[%s] answered initial offer (candidates=%d, tracks=%d)", req.Peer,
		strings.Count(sdp, "a=candidate"), peer.subCount())

	// 关键：answer 的 m-line 数必须等于 offer 的 m-line 数，
	// 所以订阅的 track 进不了首轮 answer，必须由服务端再发一次 offer 才能加上。
	//
	// 【P0-C】原来是 time.Sleep(600ms) 之后才补协商 —— 进房后 600 ms 内
	// 这个 peer 和房间里任何人之间都没有媒体通路，这是「快 1 秒」最直接的一笔账。
	// 改成：连接态一进 connected 就立刻补，不再等固定时间。
	go func() {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if peer.PC.ConnectionState() == webrtc.PeerConnectionStateConnected {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if n := peer.subCount(); n > 0 {
			log.Printf("[%s] 补协商：需要新增 %d 路", req.Peer, n)
			peer.renegotiate()
		}
	}()
}

func handleAnswer(w http.ResponseWriter, r *http.Request) {
	var req signalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	room := getRoom(req.Room)
	room.mu.RLock()
	peer := room.peers[req.Peer]
	room.mu.RUnlock()
	if peer == nil {
		http.Error(w, "unknown peer", 404)
		return
	}
	if err := peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer, SDP: req.SDP,
	}); err != nil {
		log.Printf("[%s] SetRemoteDescription(answer): %v", req.Peer, err)
		http.Error(w, err.Error(), 500)
		return
	}
	peer.onAnswerApplied()
	w.Write([]byte("ok"))
}

// handleEvents 是 SSE 长连接，服务端用它主动推 offer 给浏览器
func handleEvents(w http.ResponseWriter, r *http.Request) {
	room := getRoom(r.URL.Query().Get("room"))
	id := r.URL.Query().Get("peer")

	room.mu.RLock()
	peer := room.peers[id]
	room.mu.RUnlock()
	if peer == nil {
		http.Error(w, "unknown peer", 404)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-peer.push:
			w.Write([]byte("data: "))
			w.Write(msg)
			w.Write([]byte("\n\n"))
			flusher.Flush()
		}
	}
}
