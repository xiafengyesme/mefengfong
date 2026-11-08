package main

// 设备管理 + 401 原因码 + 验证码登录的接线层。
//
// 两个增量包（auth / authcode）原样放进子目录，这里只做三件事：
//   1. 用我们的 JSON 库实现 auth.Store（设备表 + 墓碑）
//   2. 用我们的账号表实现 authcode.Users
//   3. 挂路由、把"发 key"的出口统一改走 auth.BindRequest
//
// 数据落在 fong.json 的 users[uid].devices / .tombs 里，跟着现有备份走。

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"fong/server/auth"
	"fong/server/authcode"
)

// ---------- 存储结构 ----------

// devRec 是持久化的一台设备。key 只存 hash（和原来的 KeyHash 口径一致）。
type devRec struct {
	ID         string `json:"id"`
	KeyHash    string `json:"keyHash"`
	Name       string `json:"name,omitempty"`
	OS         string `json:"os,omitempty"`
	App        string `json:"app,omitempty"`
	LastActive int64  `json:"lastActive,omitempty"`
	Seq        int64  `json:"seq"`
}

// deviceStore 实现 auth.Store。
//
// 用自己的锁而不是 db.mu：现有代码里有几处是"先拿 db.mu 再调 authUser"，
// 如果这里也去抢 db.mu 会直接死锁。设备表按 uid 分段，锁粒度也更细。
type deviceStore struct {
	mu   sync.Mutex
	seqs map[string]int64
}

var devStore = &deviceStore{seqs: map[string]int64{}}

func (s *deviceStore) nextSeq(uid string) int64 {
	if v, ok := s.seqs[uid]; ok {
		s.seqs[uid] = v + 1
		return v + 1
	}
	s.seqs[uid] = 1
	return 1
}

// user 不加 db.mu：现有代码里有多处「先持 db.mu 再调 authUser」，
// 这里再抢 db.mu 会死锁。读的是已有条目，和改造前的 authUser 同一风险口径。
func (s *deviceStore) user(uid string) *User {
	return db.Users[uid]
}

func (s *deviceStore) List(uid string) ([]auth.Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return nil, nil
	}
	out := make([]auth.Entry, 0, len(u.Devices))
	for _, d := range u.Devices {
		out = append(out, auth.Entry{
			DeviceID:   d.ID,
			Meta:       auth.Meta{Name: d.Name, OS: d.OS, App: d.App},
			LastActive: d.LastActive,
		})
	}
	// 最近活跃倒序；同刻按 seq 倒序，输出稳定
	sortEntries(out, u.Devices)
	return out, nil
}

// sortEntries 按 lastActive 倒序、seq 倒序排（和契约一致）。
func sortEntries(out []auth.Entry, recs []devRec) {
	idx := map[string]int{}
	for i, r := range recs {
		idx[r.ID] = i
	}
	// 简单插入排序：设备最多 5 台
	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			a, b := out[j-1], out[j]
			ai, bi := idx[a.DeviceID], idx[b.DeviceID]
			if a.LastActive > b.LastActive || (a.LastActive == b.LastActive && recs[ai].Seq > recs[bi].Seq) {
				break
			}
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
}

func (s *deviceStore) Bind(uid string, e auth.Entry) ([]auth.Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return nil, errNoUser
	}
	kh := hashKey(e.Key)
	now := e.LastActive
	if now == 0 {
		now = time.Now().Unix()
	}
	// 已存在同设备 → 换 key（同设备重新登录）
	found := false
	for i := range u.Devices {
		if u.Devices[i].ID == e.DeviceID {
			u.Devices[i].KeyHash = kh
			u.Devices[i].LastActive = now
			if e.Meta.Name != "" {
				u.Devices[i].Name = e.Meta.Name
			}
			if e.Meta.OS != "" {
				u.Devices[i].OS = e.Meta.OS
			}
			if e.Meta.App != "" {
				u.Devices[i].App = e.Meta.App
			}
			found = true
			break
		}
	}
	if !found {
		u.Devices = append(u.Devices, devRec{
			ID: e.DeviceID, KeyHash: kh, Name: e.Meta.Name, OS: e.Meta.OS, App: e.Meta.App,
			LastActive: now, Seq: s.nextSeq(uid),
		})
	}
	// 超上限：按 seq 淘汰最旧，写墓碑（reason=evicted）
	var evicted []auth.Entry
	for len(u.Devices) > auth.MaxDevices {
		oldest := 0
		for i := range u.Devices {
			if u.Devices[i].Seq < u.Devices[oldest].Seq {
				oldest = i
			}
		}
		victim := u.Devices[oldest]
		u.Devices = append(u.Devices[:oldest], u.Devices[oldest+1:]...)
		s.tombLocked(u, victim.KeyHash, auth.ReasonEvicted)
		evicted = append(evicted, auth.Entry{DeviceID: victim.ID, LastActive: victim.LastActive})
	}
	markDirty()
	return evicted, nil
}

func (s *deviceStore) ByKey(uid, key string) (auth.Entry, auth.Verdict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return auth.Entry{}, auth.Verdict{Reason: auth.ReasonUnknown}, nil
	}
	kh := hashKey(key)
	for _, d := range u.Devices {
		if subtle.ConstantTimeCompare([]byte(d.KeyHash), []byte(kh)) == 1 {
			return auth.Entry{DeviceID: d.ID, Meta: auth.Meta{Name: d.Name, OS: d.OS, App: d.App}, LastActive: d.LastActive},
				auth.Verdict{OK: true}, nil
		}
	}
	if reason, ok := u.Tombs[kh]; ok {
		return auth.Entry{}, auth.Verdict{Reason: reason}, nil
	}
	return auth.Entry{}, auth.Verdict{Reason: auth.ReasonUnknown}, nil
}

func (s *deviceStore) Touch(uid, deviceID string, at int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return nil
	}
	for i := range u.Devices {
		if u.Devices[i].ID == deviceID {
			u.Devices[i].LastActive = at
			markDirty()
			return nil
		}
	}
	return nil
}

func (s *deviceStore) Delete(uid, deviceID string) (*auth.Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return nil, nil
	}
	for i := range u.Devices {
		if u.Devices[i].ID == deviceID {
			victim := u.Devices[i]
			u.Devices = append(u.Devices[:i], u.Devices[i+1:]...)
			s.tombLocked(u, victim.KeyHash, auth.ReasonEvicted)
			markDirty()
			return &auth.Entry{DeviceID: victim.ID, LastActive: victim.LastActive}, nil
		}
	}
	return nil, nil
}

func (s *deviceStore) RevokeAll(uid, reason string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.user(uid)
	if u == nil {
		return 0, nil
	}
	n := len(u.Devices)
	for _, d := range u.Devices {
		s.tombLocked(u, d.KeyHash, reason)
	}
	u.Devices = nil
	markDirty()
	return n, nil
}

// tombLocked 记一条墓碑，最多保留 64 条（超出丢最早的）。
func (s *deviceStore) tombLocked(u *User, keyHash, reason string) {
	if u.Tombs == nil {
		u.Tombs = map[string]string{}
	}
	if len(u.Tombs) >= 64 {
		// map 无序，简单粗暴：满了就清一半（墓碑只用于区分 401 原因，丢了最坏是 unknown）
		i := 0
		for k := range u.Tombs {
			delete(u.Tombs, k)
			if i++; i > 32 {
				break
			}
		}
	}
	u.Tombs[keyHash] = reason
}

var errNoUser = apiErr{code: 401, msg: "未注册"}

// markDirty 不抢 db.mu：Bind/Touch 可能发生在已持 db.mu 的登录路径里。
// 单个 bool 的写入，最坏情况是这一次脏标记丢了，下一次写会再置上。
func markDirty() { db.dirty = true }

// ---------- 401 带原因 ----------

// unauth 是带 reason 的 401，writeErr 会把它展开成 {"error":..., "reason":...}。
func unauth(msg, reason string) error { return apiErr{code: 401, msg: msg, reason: reason} }

// reasonText 与客户端 fong-wire.js 的 reasonText 逐字一致。
func reasonText(reason string) string {
	switch reason {
	case auth.ReasonEvicted:
		return "这台设备已被移出登录，请重新登录"
	case auth.ReasonPassword:
		return "密码已修改，请重新登录"
	default:
		return "登录已过期，请重新登录"
	}
}

// authUserDev 是 authUser 的带设备号版本：设备列表要用它算 current。
func authUserDev(r *http.Request) (*User, string, error) {
	uid := r.Header.Get(auth.HeaderUID)
	key := r.Header.Get(auth.HeaderKey)
	if uid == "" || key == "" {
		return nil, "", unauth("缺少身份", auth.ReasonUnknown)
	}
	e, v, err := devStore.ByKey(uid, key)
	if err != nil {
		return nil, "", fail(500, "服务错误")
	}
	if !v.OK {
		return nil, "", unauth(reasonText(v.Reason), v.Reason)
	}
	// 不能在这里抢 db.mu：登录路径是「db.mu → devStore.mu」，这里是「devStore.mu → db.mu」，
	// 两边一交叉就是死锁（实测：设备列表接口把服务挂住）。读已有条目和改造前同一口径。
	u := db.Users[uid]
	if u == nil {
		return nil, "", unauth("未注册", auth.ReasonUnknown)
	}
	_ = devStore.Touch(uid, e.DeviceID, time.Now().Unix())
	return u, e.DeviceID, nil
}

// ---------- 设备接口 ----------

func apiListDevices(w http.ResponseWriter, r *http.Request) {
	u, cur, err := authUserDev(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	list, err := devStore.List(u.ID)
	if err != nil {
		writeErr(w, fail(500, "读取设备列表失败，请稍后再试"))
		return
	}
	out := make([]auth.Device, 0, len(list))
	for _, e := range list {
		out = append(out, auth.Device{
			ID: e.DeviceID, Name: e.Meta.Name, OS: e.Meta.OS, App: e.Meta.App,
			LastActive: e.LastActive, Current: e.DeviceID == cur,
		})
	}
	writeJSON(w, 200, map[string]any{"devices": out})
}

func apiRemoveDevice(w http.ResponseWriter, r *http.Request) {
	u, _, err := authUserDev(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, fail(400, "请求格式不对"))
		return
	}
	if !auth.ValidDeviceID(req.ID) {
		writeErr(w, fail(400, "设备编号不合法"))
		return
	}
	del, err := devStore.Delete(u.ID, strings.ToLower(req.ID))
	if err != nil {
		writeErr(w, fail(500, "移除设备失败，请稍后再试"))
		return
	}
	if del == nil {
		writeErr(w, fail(404, "没找到这台设备，可能已经移除过了"))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- 验证码登录 ----------

// codeUsers 把验证码流程接到现有账号表。
type codeUsers struct{}

func (codeUsers) ByEmail(email string) (authcode.User, bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	uid, ok := db.Emails[email]
	if !ok {
		return authcode.User{}, false, nil
	}
	u := db.Users[uid]
	if u == nil {
		return authcode.User{}, false, nil
	}
	return authcode.User{ID: u.ID, Name: u.Name, Email: u.Email}, true, nil
}

// IssueKey 只生成 key，不写设备表 —— 落库统一由 BindKey → auth.BindRequest 做。
func (codeUsers) IssueKey(uid string) (authcode.User, error) {
	db.mu.Lock()
	u := db.Users[uid]
	db.mu.Unlock()
	if u == nil {
		return authcode.User{}, errNoUser
	}
	return authcode.User{ID: u.ID, Name: u.Name, Email: u.Email, Key: issueKey()}, nil
}

// CreateForCode 新邮箱自动建号（对同一邮箱幂等）。
func (codeUsers) CreateForCode(email string) (authcode.User, error) {
	db.mu.Lock()
	if uid, ok := db.Emails[email]; ok {
		u := db.Users[uid]
		db.mu.Unlock()
		if u == nil {
			return authcode.User{}, errNoUser
		}
		return authcode.User{ID: u.ID, Name: u.Name, Email: u.Email, Key: issueKey()}, nil
	}
	nick, err := authcode.RandomNickname()
	if err != nil {
		db.mu.Unlock()
		return authcode.User{}, err
	}
	uid := newID(16)
	key := issueKey()
	u := &User{ID: uid, Name: nick, Email: email, CreatedAt: time.Now().UnixMilli()}
	db.Users[uid] = u
	db.Emails[email] = uid
	db.dirty = true
	db.mu.Unlock()
	log.Printf("[auth] 验证码建号 %s (%s)", email, uid[:8])
	return authcode.User{ID: uid, Name: nick, Email: email, Key: key}, nil
}

// bindDevice 是所有"发 key"出口唯一该调的绑定入口。
func bindDevice(r *http.Request, uid, key string) error {
	_, err := auth.BindRequest(devStore, r, uid, key)
	return err
}

// codeMailReady 表示服务端配了真实发信通道。
// 没配时前端把「验证码」页签藏起来 —— 让用户点了收不到信比不显示更糟。
var codeMailReady bool

// newCodeHandler 按环境变量决定发信通道：
//
//	FONG_SMTP_HOST / FONG_SMTP_PORT / FONG_SMTP_USER / FONG_SMTP_PASS / FONG_SMTP_FROM
//
// 没配就退回 LogSender（验证码只打日志，内测用）。
func newCodeHandler() *authcode.Handler {
	h := &authcode.Handler{
		Store: authcode.NewMemStore(),
		Users: codeUsers{},
		Logf:  log.Printf,
		// 单台服务器 + nginx 一层：直连 8443 时 TCP 对端就是真实 IP；
		// 经 nginx 443 转发时对端是 127.0.0.1。这里取 0（只认 TCP 对端），
		// 宁可 443 入口共用一份 IP 额度，也不让客户端伪造 X-Forwarded-For。
		TrustedProxyHops:    0,
		MaxSendPerIPPerHour: 20,
		BindKey: func(r *http.Request, u authcode.User) error {
			return bindDevice(r, u.ID, u.Key)
		},
	}
	host := strings.TrimSpace(os.Getenv("FONG_SMTP_HOST"))
	user := strings.TrimSpace(os.Getenv("FONG_SMTP_USER"))
	pass := os.Getenv("FONG_SMTP_PASS")
	from := strings.TrimSpace(os.Getenv("FONG_SMTP_FROM"))
	if host != "" && user != "" && pass != "" {
		port := 587
		if v := strings.TrimSpace(os.Getenv("FONG_SMTP_PORT")); v != "" {
			if p, err := json.Number(v).Int64(); err == nil {
				port = int(p)
			}
		}
		if from == "" {
			from = user
		}
		implicit := port == 465
		h.Sender = &authcode.SMTPSender{
			Addr: fmt.Sprintf("%s:%d", host, port), Host: host,
			User: user, Pass: pass, From: from, FromName: "FONG",
			ImplicitTLS: implicit, Timeout: 15 * time.Second,
			HeloName: "fongget.xyz",
		}
		codeMailReady = true
		log.Printf("[authcode] 发信通道 SMTP %s:%d（%s）", host, port, from)
	} else {
		h.Sender = &authcode.LogSender{Logf: log.Printf}
		codeMailReady = false
		log.Printf("[authcode] 未配置 SMTP，验证码只打日志（内测模式）")
	}
	return h
}

// randHex 生成长度 n 的十六进制随机串。
func randHex(n int) string {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n)
	}
	return hex.EncodeToString(b)[:n]
}
