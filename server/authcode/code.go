// Package authcode —— FONG 验证码登录（接口约定 04 §1）
//
// 契约（与文档逐字对齐）：
//
//	POST /api/auth/code/send   { "email": "x@qq.com" }
//	  200 { "cooldown": 60 }
//	  429 { "error": "发送太频繁，请 1 小时后再试", "retryAfter": 3600 }
//
//	POST /api/auth/code/login  { "email": "x@qq.com", "code": "123456" }
//	  200 { "id", "name", "key", "email" }     ← 与现有 /api/auth/login 返回一致
//	  400 { "error": "验证码不正确" }
//	  410 { "error": "验证码已过期，请重新获取" }
//
// 只依赖标准库。发信走 Sender 接口（见 sender.go），存储走 Store 接口（本文件内存实现）。
package authcode

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// 契约里写死的三个数：
const (
	CodeLen        = 6                // 验证码 6 位数字
	CodeTTL        = 10 * time.Minute // 10 分钟有效
	SendCooldown   = 60 * time.Second // 同一邮箱 60 s 冷却
	MaxSendPerHour = 10               // 同一邮箱每小时最多 10 次
)

// 契约**没有**写、但必须有的两个闸门（6 位码只有 100 万种，不限次数就能暴力猜）：
const (
	MaxVerifyAttempts = 5  // 同一邮箱连续猜错 5 次 → 作废这个码，必须重新获取
	MaxVerifyPerHour  = 20 // 同一邮箱每小时最多校验 20 次（含猜错的）
)

// Record 是一次已发出的验证码。
type Record struct {
	Email     string
	Code      string
	IssuedAt  time.Time
	ExpiresAt time.Time
	Attempts  int // 猜错次数
	Consumed  bool
}

// Store 是验证码存储。生产建议落 Redis（带 TTL）或你们现有的 KV/表。
type Store interface {
	Put(email string, r Record) error
	Get(email string) (Record, bool, error)
	// Delete 发放成功后删掉旧码；校验成功/作废也删。
	Delete(email string) error
	// Sends 返回 since 之后该邮箱的发放时间（升序）。
	// 给 handler 用来同时算"60 s 冷却还剩几秒"和"每小时 10 次的回退秒数"。
	Sends(email string, since time.Time) ([]time.Time, error)
	// CountVerify 返回 since 之后该邮箱的校验次数（含猜错的）。
	CountVerify(email string, since time.Time) (int, error)
	// IncrVerify 记一次校验尝试。
	IncrVerify(email string, at time.Time) error
	// RecordSend 记一次成功发放。
	RecordSend(email string, at time.Time) error
	// CountSendsByIP / RecordSendByIP 用于按来源 IP 限流（防同一出口刷多个邮箱）。
	CountSendsByIP(ip string, since time.Time) (int, error)
	RecordSendByIP(ip string, at time.Time) error
}

// Locker（可选）：Store 若实现它，Handler 就用它做"同一邮箱 / 同一 IP"的互斥，
// 否则退回进程内分段锁。
//
// 【核对轮新增】发码与校验都是"先读计数/记录 → 判断 → 再写"，不加锁时并发请求会同时读到旧值：
// 60 个并发猜码能全部被比对（绕过"连错 5 次作废"和"每小时 20 次"）、同一个码能并发换出多个 key、
// 冷却内并发发码能发出多封。单实例部署用进程内锁即可；**多实例（多台 /api 机器）必须由 Store 实现 Locker**，
// 例如 Redis：SET fong:lock:<key> <token> NX PX 5000，解锁用比对 token 的 Lua 脚本删除。
type Locker interface {
	Lock(ctx context.Context, key string) (unlock func(), err error)
}

// stripedLock 是进程内的分段锁（256 段，按 key 的 FNV 哈希选段）。只保证单进程内互斥。
type stripedLock struct{ mu [256]sync.Mutex }

func (l *stripedLock) Lock(_ context.Context, key string) (func(), error) {
	f := fnv.New32a()
	_, _ = f.Write([]byte(key))
	m := &l.mu[f.Sum32()%uint32(len(l.mu))]
	m.Lock()
	return m.Unlock, nil
}

// ---------- 内存实现 ----------

type memStore struct {
	mu       sync.Mutex
	codes    map[string]Record
	sends    map[string][]time.Time
	verifies map[string][]time.Time
	ipSends  map[string][]time.Time
	writes   int // 【核对轮新增】写入计数，每 sweepEvery 次顺手清一次过期数据
}

// sweepEvery 内存实现每写入这么多次就清理一次过期项，防止"很多不同邮箱/IP 各来一次"把内存撑满。
const sweepEvery = 512

// NewMemStore 建内存存储（重启即清，只适合测试/单机）。
func NewMemStore() Store {
	return &memStore{
		codes: map[string]Record{}, sends: map[string][]time.Time{},
		verifies: map[string][]time.Time{}, ipSends: map[string][]time.Time{},
	}
}

func (s *memStore) Put(email string, r Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[email] = r
	s.maybeSweep(r.IssuedAt)
	return nil
}

// maybeSweep 在持锁状态下调用。
func (s *memStore) maybeSweep(now time.Time) {
	s.writes++
	if s.writes%sweepEvery != 0 || now.IsZero() {
		return
	}
	s.sweepLocked(now)
}

// sweepLocked 删掉已过期的码、超出统计窗口的时间戳，以及因此变空的键。
func (s *memStore) sweepLocked(now time.Time) {
	for k, r := range s.codes {
		if now.After(r.ExpiresAt) {
			delete(s.codes, k)
		}
	}
	for _, m := range []struct {
		mp  map[string][]time.Time
		win time.Duration
	}{{s.sends, 25 * time.Hour}, {s.verifies, 2 * time.Hour}, {s.ipSends, 25 * time.Hour}} {
		for k, ts := range m.mp {
			ts = trimBefore(ts, now.Add(-m.win))
			if len(ts) == 0 {
				delete(m.mp, k)
			} else {
				m.mp[k] = ts
			}
		}
	}
}

func (s *memStore) Get(email string) (Record, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.codes[email]
	return r, ok, nil
}

func (s *memStore) Delete(email string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.codes, email)
	return nil
}

func (s *memStore) Sends(email string, since time.Time) ([]time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []time.Time
	for _, t := range s.sends[email] {
		if t.After(since) {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out, nil
}

func (s *memStore) CountVerify(email string, since time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, t := range s.verifies[email] {
		if t.After(since) {
			n++
		}
	}
	return n, nil
}

func (s *memStore) IncrVerify(email string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.verifies[email] = append(trimBefore(s.verifies[email], at.Add(-2*time.Hour)), at)
	s.maybeSweep(at)
	return nil
}

func (s *memStore) RecordSend(email string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sends[email] = append(trimBefore(s.sends[email], at.Add(-25*time.Hour)), at)
	s.maybeSweep(at)
	return nil
}

func (s *memStore) CountSendsByIP(ip string, since time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, t := range s.ipSends[ip] {
		if t.After(since) {
			n++
		}
	}
	return n, nil
}

func (s *memStore) RecordSendByIP(ip string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ipSends[ip] = append(trimBefore(s.ipSends[ip], at.Add(-25*time.Hour)), at)
	s.maybeSweep(at)
	return nil
}

func trimBefore(ts []time.Time, cut time.Time) []time.Time {
	out := ts[:0]
	for _, t := range ts {
		if t.After(cut) {
			out = append(out, t)
		}
	}
	return out
}

// ---------- 工具 ----------

// GenCode 生成 6 位数字验证码（crypto/rand，不是 math/rand）。
func GenCode() (string, error) {
	buf := make([]byte, CodeLen)
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", fmt.Errorf("生成验证码失败: %w", err)
		}
		buf[i] = byte('0' + n.Int64())
	}
	return string(buf), nil
}

// NormalizeEmail 统一小写去空白；登录与发码两边必须用同一套，否则会出现
// "发给 A@x.com、校验 a@x.com 找不到"这种鬼问题。
func NormalizeEmail(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// ValidEmail 邮箱格式校验（ASCII 口径）。
//
// 【核对轮收紧】原实现只挡空白，`a<b@x.com`、`a@x.com>`、含 \x00 / 逗号 / 分号 / 引号的地址都能过，
// 进到邮件头（To: <...>）和 SMTP RCPT 里会破坏地址语法。现在：
//   - 本地部分只允许 RFC 5322 atext 字符与点，点不能打头/结尾/连续，长度 ≤ 64；
//   - 域名按 label 校验：字母数字与连字符，连字符不打头不结尾，每段 ≤ 63，至少两段；
//   - 全长 ≤ 254；不支持非 ASCII（国际化邮箱）—— 国内主流邮箱都不涉及。
func ValidEmail(s string) bool {
	if s == "" || len(s) > 254 {
		return false
	}
	at := strings.LastIndex(s, "@")
	if at <= 0 || at == len(s)-1 {
		return false
	}
	local, domain := s[:at], s[at+1:]
	if len(local) > 64 || local[0] == '.' || local[len(local)-1] == '.' || strings.Contains(local, "..") {
		return false
	}
	for i := 0; i < len(local); i++ {
		c := local[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte(".!#$%&'*+/=?^_`{|}~-", c) >= 0:
		default:
			return false
		}
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for i := 0; i < len(l); i++ {
			c := l[i]
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

// codeEqual 常数时间比较验证码（别用 ==，会被时间侧信道蹭）。
func codeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// RandomNickname 新邮箱注册时生成的昵称：契约要求 "玩家xxxx"。
func RandomNickname() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(10000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("玩家%04d", n.Int64()), nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
