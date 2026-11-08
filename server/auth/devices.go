// Package auth —— FONG 设备管理 + 401 原因码（接口约定 04 §1 §2 §3）
//
// 与现有 /api/* 风格对齐：JSON、认证头 X-Fong-Uid + X-Fong-Key、错误 { "error": "给用户看的文案" }。
// 只依赖标准库；存储走 Store 接口，内存实现用于测试，生产换成你们现有的 key 表即可。
//
// 关键关系：**一个 key 绑一台设备**。
//   - 登录/绑定成功 → Bind()：写进该用户的设备表；超过上限按 FIFO 淘汰最旧那台。
//   - 被淘汰 / 被删 / 改密 → 记进"墓碑"（带原因），之后再用这个 key 请求会拿到对应 reason。
//
// 所以 ①设备管理 与 ②401原因码 是同一件事的两面：淘汰 = 下一次请求收到 evicted。
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// MaxDevices 是每账号设备上限，沿用服务端现有的 5（主 key + 4 个额外 key）。
const MaxDevices = 5

// tombstoneMax 每个账号保留多少条"已吊销 key"用于区分 401 原因。
const tombstoneMax = 64

// 401 的 reason 取值，前端按它选 SIGNED_OUT_TEXT 里的文案。
const (
	ReasonEvicted  = "evicted"  // 被其它设备挤出登录（FIFO 淘汰 / 在设备列表里被移除）
	ReasonPassword = "password" // 改过密码，所有旧 key 失效
	ReasonUnknown  = "unknown"  // 其它（伪造、过期、从未见过）
)

// 认证/设备相关的请求头。
const (
	HeaderUID    = "X-Fong-Uid"
	HeaderKey    = "X-Fong-Key"
	HeaderDevice = "X-Fong-Device"
)

// Device 是 GET /api/auth/devices 返回给前端的一项，字段与契约逐一对齐。
type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	OS         string `json:"os"`
	App        string `json:"app"`
	LastActive int64  `json:"lastActive"` // Unix 秒
	Current    bool   `json:"current"`    // 是不是本次请求这台设备
}

// Meta 是设备自报信息。
type Meta struct {
	Name string `json:"name"`
	OS   string `json:"os"`
	App  string `json:"app"`
}

// Entry 是存储层一条记录：一台设备 + 它绑定的 key。
type Entry struct {
	DeviceID   string
	Key        string
	Meta       Meta
	LastActive int64
	seq        int64 // 内部：FIFO 依据
}

// Verdict 是 key 查询的结论，直接映射到 401 的 reason。
type Verdict struct {
	OK     bool
	Reason string // OK=false 时有效
}

type tomb struct {
	key    string
	reason string
}

// Store 是设备表。生产实现建议直接落到你们现有的 key 表（见 接入说明.md 的 SQL）。
type Store interface {
	// List 按最近活跃倒序返回该账号的设备。
	List(uid string) ([]Entry, error)
	// Bind 绑定（或刷新）一台设备；超上限时返回被淘汰的记录。
	Bind(uid string, e Entry) (evicted []Entry, err error)
	// ByKey 用 key 反查设备。
	ByKey(uid, key string) (Entry, Verdict, error)
	// Touch 刷新最近活跃时间。
	Touch(uid, deviceID string, at int64) error
	// Delete 删除一台设备的绑定；返回被删记录。
	Delete(uid, deviceID string) (*Entry, error)
	// RevokeAll 吊销该账号全部 key（改密时用），返回吊销条数；这些 key 之后会拿到 reason。
	RevokeAll(uid, reason string) (int, error)
}

// ---------- 内存实现 ----------

type memStore struct {
	mu     sync.Mutex
	byUser map[string][]Entry
	tombs  map[string][]tomb
	seq    int64
	maxDev int
}

// NewMemStore 建一个内存设备表；maxDev <= 0 时用 MaxDevices。
func NewMemStore(maxDev int) Store {
	if maxDev <= 0 {
		maxDev = MaxDevices
	}
	return &memStore{byUser: map[string][]Entry{}, tombs: map[string][]tomb{}, maxDev: maxDev}
}

func (s *memStore) List(uid string) ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := append([]Entry(nil), s.byUser[uid]...)
	// 最近活跃优先；同刻按 seq 倒序，保证输出稳定可测
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].LastActive != list[j].LastActive {
			return list[i].LastActive > list[j].LastActive
		}
		return list[i].seq > list[j].seq
	})
	return list, nil
}

func (s *memStore) Bind(uid string, e Entry) ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e.DeviceID = NormalizeDeviceID(e.DeviceID, e.Key)
	s.seq++
	e.seq = s.seq
	if e.LastActive == 0 {
		e.LastActive = time.Now().Unix()
	}
	list := s.byUser[uid]
	// 同一台设备重复绑定 → 换 key，不占新名额，也不该被判 evicted
	for i := range list {
		if list[i].DeviceID == e.DeviceID {
			// 旧 key 作废并留墓碑（下一次用它请求判 evicted，而不是 unknown）
			s.remember(uid, list[i].Key, ReasonEvicted)
			list[i] = e
			s.byUser[uid] = list
			return nil, nil
		}
	}
	list = append(list, e)
	var evicted []Entry
	for len(list) > s.maxDev { // FIFO：淘汰最旧（seq 最小）
		oldest := 0
		for i := range list {
			if list[i].seq < list[oldest].seq {
				oldest = i
			}
		}
		ev := list[oldest]
		list = append(list[:oldest], list[oldest+1:]...)
		s.remember(uid, ev.Key, ReasonEvicted)
		evicted = append(evicted, ev)
	}
	s.byUser[uid] = list
	return evicted, nil
}

func (s *memStore) ByKey(uid, key string) (Entry, Verdict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if key == "" {
		return Entry{}, Verdict{Reason: ReasonUnknown}, nil
	}
	for _, e := range s.byUser[uid] {
		if subtle.ConstantTimeCompare([]byte(e.Key), []byte(key)) == 1 {
			return e, Verdict{OK: true}, nil
		}
	}
	for _, t := range s.tombs[uid] {
		if subtle.ConstantTimeCompare([]byte(t.key), []byte(key)) == 1 {
			r := t.reason
			if r == "" {
				r = ReasonEvicted
			}
			return Entry{}, Verdict{Reason: r}, nil
		}
	}
	return Entry{}, Verdict{Reason: ReasonUnknown}, nil
}

func (s *memStore) Touch(uid, deviceID string, at int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.byUser[uid]
	for i := range list {
		if list[i].DeviceID == deviceID {
			list[i].LastActive = at
			return nil
		}
	}
	return nil
}

func (s *memStore) Delete(uid, deviceID string) (*Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.byUser[uid]
	for i := range list {
		if list[i].DeviceID == deviceID {
			del := list[i]
			s.byUser[uid] = append(list[:i], list[i+1:]...)
			s.remember(uid, del.Key, ReasonEvicted)
			return &del, nil
		}
	}
	return nil, nil
}

func (s *memStore) RevokeAll(uid, reason string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reason == "" {
		reason = ReasonPassword
	}
	n := 0
	for _, e := range s.byUser[uid] {
		s.remember(uid, e.Key, reason)
		n++
	}
	s.byUser[uid] = nil
	return n, nil
}

func (s *memStore) forget(uid, key string) {
	t := s.tombs[uid]
	for i := range t {
		if t[i].key == key {
			s.tombs[uid] = append(t[:i], t[i+1:]...)
			return
		}
	}
}

func (s *memStore) remember(uid, key, reason string) {
	if key == "" {
		return
	}
	s.forget(uid, key)
	t := append(s.tombs[uid], tomb{key: key, reason: reason})
	if len(t) > tombstoneMax {
		t = t[len(t)-tombstoneMax:]
	}
	s.tombs[uid] = t
}

// ---------- HTTP ----------

// Handler 承载认证、设备管理与 401 原因码。
type Handler struct {
	Store Store
	Max   int
	Now   func() int64 // 可注入，便于测试
}

// New 建一个 Handler，默认用内存表。
func New(store Store) *Handler {
	if store == nil {
		store = NewMemStore(MaxDevices)
	}
	return &Handler{Store: store}
}

func (h *Handler) now() int64 {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now().Unix()
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// WriteUnauthorized 是所有需要认证的接口在 401 时该走的那一个出口。
// 契约要求带上 reason，前端按它选文案并回登录门。
func WriteUnauthorized(w http.ResponseWriter, reason, msg string) {
	if reason == "" {
		reason = ReasonUnknown
	}
	if msg == "" {
		msg = "登录状态已失效，请重新登录"
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": msg, "reason": reason})
}

// Authed 是认证通过后的业务处理函数。
type Authed func(w http.ResponseWriter, r *http.Request, uid, device string)

// Require 做认证：校验 X-Fong-Uid / X-Fong-Key（可选 X-Fong-Device），
// 失败按原因回 401，成功则刷新最近活跃时间并把 uid/device 交给业务。
func (h *Handler) Require(next Authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := strings.TrimSpace(r.Header.Get(HeaderUID))
		key := strings.TrimSpace(r.Header.Get(HeaderKey))
		if uid == "" || key == "" {
			WriteUnauthorized(w, ReasonUnknown, "登录状态已失效，请重新登录")
			return
		}
		e, v, err := h.Store.ByKey(uid, key)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "校验登录状态失败，请稍后再试")
			return
		}
		if !v.OK {
			switch v.Reason {
			case ReasonPassword:
				WriteUnauthorized(w, ReasonPassword, "密码已修改，请重新登录")
			case ReasonEvicted:
				WriteUnauthorized(w, ReasonEvicted, "这台设备已被移出登录，请重新登录")
			default:
				WriteUnauthorized(w, ReasonUnknown, "登录状态已失效，请重新登录")
			}
			return
		}
		// 【核对轮】以 key 实际绑定的设备为准，不信请求头自报的设备号：
		// 原实现持 A 设备的 key、头里报 B，会把 B 标成 current 并刷新 B 的 lastActive。
		dev := e.DeviceID
		_ = h.Store.Touch(uid, dev, h.now())
		next(w, r, uid, dev)
	}
}

// GET /api/auth/devices —— 列出本账号已登录的设备，标出当前这台。
//
// 空列表也必须返回 []（不是 null）：前端是 for...of 直接遍历的。
func (h *Handler) ListDevices(w http.ResponseWriter, r *http.Request, uid, curDevice string) {
	list, err := h.Store.List(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取设备列表失败，请稍后再试")
		return
	}
	out := make([]Device, 0, len(list))
	for _, e := range list {
		out = append(out, Device{
			ID: e.DeviceID, Name: e.Meta.Name, OS: e.Meta.OS, App: e.Meta.App,
			LastActive: e.LastActive, Current: curDevice != "" && e.DeviceID == curDevice,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

type removeReq struct {
	ID string `json:"id"`
}

// POST /api/auth/devices/remove { "id": "<device id>" }
//
// 删掉当前这台也是允许的：它等于"从这台设备退出登录"，key 立即失效，
// 这台设备的下一次请求会拿到 401 reason="evicted" 并回到登录门。
func (h *Handler) RemoveDevice(w http.ResponseWriter, r *http.Request, uid, curDevice string) {
	var req removeReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式不对")
		return
	}
	if !ValidDeviceID(req.ID) {
		writeErr(w, http.StatusBadRequest, "设备编号不合法")
		return
	}
	del, err := h.Store.Delete(uid, strings.ToLower(req.ID))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "移除设备失败，请稍后再试")
		return
	}
	if del == nil {
		writeErr(w, http.StatusNotFound, "没找到这台设备，可能已经移除过了")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// MetaFromUA 从 User-Agent 推设备信息，给"客户端没上报 name/os/app"时的兜底。
// Electron 的 UA 里带系统与 FONG/<版本>，够把列表填成人看得懂的样子。
func MetaFromUA(ua string) Meta {
	m := Meta{App: "FONG"}
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "windows"):
		m.OS, m.Name = "windows", "Windows 电脑"
	case strings.Contains(l, "macintosh"), strings.Contains(l, "mac os"):
		m.OS, m.Name = "macos", "Mac"
	case strings.Contains(l, "iphone"), strings.Contains(l, "ipad"):
		m.OS, m.Name = "ios", "iPhone / iPad"
	case strings.Contains(l, "android"):
		m.OS, m.Name = "android", "Android 设备"
	case strings.Contains(l, "linux"):
		m.OS, m.Name = "linux", "Linux 电脑"
	default:
		m.OS, m.Name = "unknown", "未知设备"
	}
	// 版本号：UA 里的 FONG/0.3.0（没有就只报产品名）
	if i := strings.Index(ua, "FONG/"); i >= 0 {
		rest := ua[i+len("FONG/"):]
		if j := strings.IndexAny(rest, " );&"); j >= 0 {
			rest = rest[:j]
		}
		if rest != "" {
			m.App = "FONG " + rest
		}
	}
	return m
}

// ValidDeviceID 校验 32 位 hex（客户端 deviceId() 的格式）。
func ValidDeviceID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// ---------- 【核对轮新增】绑定入口 ----------

// NormalizeDeviceID 把客户端上报的设备号规整成存储用的口径：
//   - 合法的 32 位 hex → 转小写原样用；
//   - 缺失或不合法（0.3.0 老客户端不带头、别的端乱填）→ 用 key 派生一个 32 位 hex，
//     **一个会话一台"设备"**。
//
// 原实现直接把空串当设备号：两个不带头的客户端被当成"同一台设备重登"，
// 后登录的把先登录的顶掉（先登录的收到 401 evicted）—— 灰度期间新老客户端混跑必然触发。
func NormalizeDeviceID(dev, key string) string {
	dev = strings.TrimSpace(dev)
	if ValidDeviceID(dev) {
		return strings.ToLower(dev)
	}
	sum := sha256.Sum256([]byte("fong-device|" + key))
	return hex.EncodeToString(sum[:16])
}

// BindRequest 是登录 / 注册 / 绑定 / 验证码登录成功后**唯一**该调的绑定入口：
// 从请求里取设备号（X-Fong-Device，缺失时按 key 派生）与 UA 兜底信息，写进设备表，
// 超上限时由 Store.Bind 做 FIFO 并给被淘汰的 key 记墓碑。
//
//	验证码包接法：authcode.Handler.BindKey = func(r *http.Request, u authcode.User) error {
//	    _, err := auth.BindRequest(store, r, u.ID, u.Key); return err }
func BindRequest(store Store, r *http.Request, uid, key string) ([]Entry, error) {
	return store.Bind(uid, Entry{
		DeviceID:   NormalizeDeviceID(r.Header.Get(HeaderDevice), key),
		Key:        key,
		Meta:       MetaFromUA(r.UserAgent()),
		LastActive: time.Now().Unix(),
	})
}
