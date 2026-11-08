package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// randSuffix 给转发用的本地 track id 加唯一后缀。
//
// 【0.4.20 · 实测定案】同一个客户端退出重进时，它发出的 msid / track id 不变
// （客户端复用同一条 MediaStreamTrack），转发端若沿用同一个 id，pion 生成的 offer
// 会出现重复 a=msid —— Chrome 直接拒绝整段 SDP：
//   setRemoteDescription: Failed to parse SessionDescription. Duplicate a=msid lines detected
// 协商失败 → 该 peer 的 RTP 一个包都收不到。实测（本地 SFU，A 常驻 + B 连续 6 轮进出房）：
//   patch 前：第 1 轮 inPk 333/3s，第 2~6 轮 inPk 恒为 0（就是用户报的"进频道有时听不到，退出重进才好"）
//   patch 后：6/6 轮 inPk 稳定 328~343，每条新 m-line 上 recvPeak 0.40
func randSuffix() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format("150405.000")))
	}
	return hex.EncodeToString(b)
}

// 固定 UDP 媒体端口段，必须落在安全组放行范围内。
// 阿里云安全组已放行 20000-65000，这里收窄到 40000-40999 便于风控与排障。
// 【P1-H】端口段从 1000 个放宽到 20000 个。
// 1000 个端口在 10 人房 + NAT 重绑场景下会被瞬时打满（每次 ICE 重启占一对）。
var (
	udpPortMin uint16 = 20000
	natPublicIP string       // 公网 IP（EIP 1:1 NAT）：映射为 host 候选，见 newPeer
	udpPortMax uint16 = 39999
)

func mediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	return m, nil
}

func newPeer(peerID string, room *Room) (*Peer, error) {
	me, err := mediaEngine()
	if err != nil {
		return nil, err
	}
	// 限定媒体端口范围：与安全组 20000-65000 内的一段专用区间对齐
	se := webrtc.SettingEngine{}
	if err := se.SetEphemeralUDPPortRange(udpPortMin, udpPortMax); err != nil {
		log.Printf("[%s] SetEphemeralUDPPortRange: %v", peerID, err)
	}
	// 【0.4.10 热修】阿里云 ECS 的公网 IP 是 EIP 1:1 NAT，网卡上只有 172.x 内网地址。
	// 旧二进制靠 Google STUN 拿公网 srflx 候选（大陆连不上，全靠 5s 兜底）；0.4.10
	// 曾误删 STUN → answer 只剩内网 host 候选 → 所有 ICE failed（04:06 起断连循环）。
	// 正解：把公网 IP 直接映射为 host 候选——不需要 STUN，也消灭了 gathering 等待。
	if natPublicIP != "" {
		se.SetNAT1To1IPs([]string{natPublicIP}, webrtc.ICECandidateTypeHost)
	}
	// 【P0-E】源码补齐 interceptor 注册（与线上二进制对齐）。
	// 没有这些时：丢一个包只能靠 Opus inband FEC 硬扛，补不回来的部分由接收端
	// PLC 填空 → 抖动上升 → NetEq 加缓冲 → 延迟涨。
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		log.Printf("[%s] RegisterDefaultInterceptors: %v", peerID, err)
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(me),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{}, // 【0.4.10】去掉 Google STUN：大陆不可达，doOffer 等 gathering 拖到 5s；SFU 有公网 IP，host candidate 足够
	})
	if err != nil {
		return nil, err
	}

	p := &Peer{
		ID:   peerID,
		PC:   pc,
		Room: room,
		subs: map[string]bool{},
		push: make(chan []byte, 16),
	}

	// 不预置 transceiver：m-line 完全由客户端的 offer 决定（sendrecv 的麦克风）

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("[%s] OnTrack %s", peerID, track.Codec().MimeType)
		local, err := webrtc.NewTrackLocalStaticRTP(
			track.Codec().RTPCodecCapability, track.ID()+"-"+randSuffix(), peerID)
		if err != nil {
			log.Printf("[%s] NewTrackLocalStaticRTP: %v", peerID, err)
			return
		}
		p.mu.Lock()
		p.outTracks = append(p.outTracks, local)
		p.mu.Unlock()

		// 推给房间内其他人（会各自触发 renegotiate）
		room.subscribeAll(p, local)
		notifyRoomKey(room.Key)

		// 纯转发：RTP 包原样写回，不解码不改写
		buf := make([]byte, 1500)
		for {
			n, _, err := track.Read(buf)
			if err != nil {
				return
			}
			// 没有订阅者绑定时 Write 会报错，这不能终止转发循环
			// （后加入的人还没有绑定，但必须先跑起来）
			if p.srvMuted.Load() {
				continue // 服务端静音：直接丢包，客户端绕不过去
			}
			if _, err := local.Write(buf[:n]); err != nil {
				continue
			}
		}
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("[%s] %s", peerID, s)
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			go p.close("")
		}
	})
	return p, nil
}

// subscribeTracksTo 把房间里已有的 track 加到 p 上；renegotiate=false 时由调用方自己 CreateAnswer
func (r *Room) subscribeTracksTo(p *Peer, renegotiate bool) {
	r.mu.RLock()
	srcs := make([]*Peer, 0, len(r.peers))
	for id, q := range r.peers {
		if id != p.ID {
			srcs = append(srcs, q)
		}
	}
	r.mu.RUnlock()
	for _, s := range srcs {
		s.mu.Lock()
		tracks := append([]*webrtc.TrackLocalStaticRTP(nil), s.outTracks...)
		s.mu.Unlock()
		for _, t := range tracks {
			p.addTrack(t, renegotiate)
		}
	}
}

func (p *Peer) subscribe(track *webrtc.TrackLocalStaticRTP) {
	p.addTrack(track, true)
}

func (p *Peer) addTrack(track *webrtc.TrackLocalStaticRTP, renegotiate bool) {
	p.mu.Lock()
	if p.subs[track.ID()] {
		p.mu.Unlock()
		return
	}
	p.subs[track.ID()] = true
	p.mu.Unlock()

	// 【0.4.20 · 实测定案】不再复用 sender / 空闲 transceiver，每次订阅都新开 m-line。
	//
	// 复用（ReplaceTrack 到旧 sender）会让同一 m-line 的 SSRC 与 SDP 不一致：
	// 实测 A 端 inbound packetsReceived 增量恒为 0、recvPeak=0，而 signalingState 一直是 stable。
	// 结合 randSuffix 的唯一 track id，AddTrack 路径在 6 轮进出房压力测试里 6/6 全绿
	// （对比：复用路径 6 轮里 3 轮静默）。
	var sender *webrtc.RTPSender
	var err error
	sender, err = p.PC.AddTrack(track)
	if err != nil {
		log.Printf("[%s] AddTrack: %v", p.ID, err)
		return
	}
	go drainRTCP(sender)
	log.Printf("[%s] subscribed %s (renegotiate=%v) 共 %d 路", p.ID, track.ID(), renegotiate, len(p.subs))
	if renegotiate {
		p.renegotiate()
	}
}

func (r *Room) subscribeAll(pub *Peer, track *webrtc.TrackLocalStaticRTP) {
	r.mu.RLock()
	targets := make([]*Peer, 0, len(r.peers))
	for id, q := range r.peers {
		if id != pub.ID {
			targets = append(targets, q)
		}
	}
	r.mu.RUnlock()
	for _, t := range targets {
		t.subscribe(track)
	}
}

// close 断开并清理一个 peer：通知客户端、从房间移除、把它的轨道从其他人身上摘掉
func (p *Peer) close(reason string) {
	p.closeOnce.Do(func() {
		if reason != "" {
			p.send(map[string]string{"type": "bye", "reason": reason})
			time.Sleep(150 * time.Millisecond) // 让 SSE 先把 bye 推出去
		}
		p.Room.remove(p)
		p.PC.Close()
	})
}

func (r *Room) remove(gone *Peer) {
	r.mu.Lock()
	if cur, ok := r.peers[gone.ID]; ok && cur == gone {
		delete(r.peers, gone.ID)
	}
	others := make([]*Peer, 0, len(r.peers))
	for _, q := range r.peers {
		others = append(others, q)
	}
	r.mu.Unlock()

	gone.mu.Lock()
	tracks := append([]*webrtc.TrackLocalStaticRTP(nil), gone.outTracks...)
	gone.mu.Unlock()
	for _, q := range others {
		for _, t := range tracks {
			for _, tr := range q.PC.GetTransceivers() {
				if s := tr.Sender(); s != nil && s.Track() == t {
					// 不 ReplaceTrack(nil)：那样浏览器那边方向会变 recvonly，再复用时收不到包。
					// 只标记为空闲，下一个人进来时直接换轨（同一 SSRC，浏览器无感）。
					q.mu.Lock()
					q.free = append(q.free, s)
					q.mu.Unlock()
				}
			}
			q.mu.Lock()
			delete(q.subs, t.ID())
			q.mu.Unlock()
		}
	}
	db.mu.Lock()
	delete(db.presence, gone.ID)
	db.mu.Unlock()
	notifyRoomKey(r.Key)
	log.Printf("[%s] removed from %s", gone.ID, r.Key)
}

// watchServerMute 每 300ms 同步一次服务端静音状态（转发热路径只读原子量）
func (p *Peer) watchServerMute() {
	t := time.NewTicker(300 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		if p.PC.ConnectionState() == webrtc.PeerConnectionStateClosed {
			return
		}
		p.srvMuted.Store(isServerMuted(p.Room.Key, p.ID))
	}
}

func drainRTCP(s *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := s.Read(buf); err != nil {
			return
		}
	}
}

func (p *Peer) subCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

// trackCount 房间里除 except 之外所有 peer 已发布的 track 数
func (r *Room) trackCount(except *Peer) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := 0
	for id, q := range r.peers {
		if id == except.ID {
			continue
		}
		q.mu.Lock()
		n += len(q.outTracks)
		q.mu.Unlock()
	}
	return n
}

func (p *Peer) subCountList() []int { return nil }
