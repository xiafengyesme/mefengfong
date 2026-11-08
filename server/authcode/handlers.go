package authcode

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"time"
)

// User 是验证成功后要返回的身份，字段与现有 /api/auth/login 的返回一致。
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Key   string `json:"key"`
	Email string `json:"email"`
}

// Users 是账号层：**你们用现有的注册/登录逻辑实现这三个方法**，
// 验证码流程本身不碰账号数据。
type Users interface {
	// ByEmail 查账号是否存在。
	ByEmail(email string) (User, bool, error)
	// IssueKey 给已存在的账号发一个新 key —— 就是现有 /api/auth/login 成功那一步。
	IssueKey(uid string) (User, error)
	// CreateForCode 新邮箱验证成功时建号并直接发 key —— 就是现有注册流程。
	// 必须对同一邮箱幂等（并发下两个请求同时到，只能建一个号）。
	CreateForCode(email string) (User, error)
}

// Handler 承载两个路由。
type Handler struct {
	Store  Store
	Sender Sender
	Users  Users
	Now    func() time.Time
	Logf   func(format string, args ...any)

	// 可选：同一来源 IP 每小时的发码上限（0 = 关闭）。
	// 防的是"一个出口刷很多个邮箱"——按邮箱限流挡不住这个。
	MaxSendPerIPPerHour int

	// 可选：登录成功后回调，用来把 key 绑到设备上。
	// 接上一批的设备管理：OnKeyIssued = func(uid, key, device string) { store.Bind(...) }
	// 【核对轮】它的失败（含 panic）会被吞掉，登录照样回 200 —— 用户拿到一个设备表里没有的 key。
	// 新代码请用下面的 BindKey；两者都设时只调 BindKey。
	OnKeyIssued func(uid, key, device string)

	// 【核对轮新增】推荐的绑定钩子：拿到整个请求（设备号、UA 都在里面），返回 error。
	// 返回非 nil → 登录回 500「登录失败，请稍后再试」，**不把 key 交给客户端**，
	// 避免"登录成功但设备列表里没有、FIFO 也不管它"的幽灵 key。
	// 与设备包的接法：BindKey = func(r *http.Request, u User) error { _, err := auth.BindRequest(store, r, u.ID, u.Key); return err }
	BindKey func(r *http.Request, u User) error

	// 【核对轮新增】前面有几层**你们自己的**反向代理（nginx / SLB）。
	//   0（默认）：完全不看 X-Forwarded-For / X-Real-IP，只用 TCP 对端地址 —— 客户端自己塞的头无效；
	//   N > 0：取 X-Forwarded-For 从右往左第 N 个（最外层可信代理记下的那个地址）。
	// 原实现无条件取 XFF 第一段，客户端随便填个头就能绕过 MaxSendPerIPPerHour。
	TrustedProxyHops int

	locks stripedLock
}

// lock 取"同一邮箱 / 同一 IP"的互斥锁：Store 实现了 Locker 就用它（多实例），否则用进程内分段锁。
func (h *Handler) lock(ctx context.Context, key string) (func(), error) {
	if l, ok := h.Store.(Locker); ok {
		return l.Lock(ctx, key)
	}
	return h.locks.Lock(ctx, key)
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h *Handler) logf(f string, a ...any) {
	if h.Logf != nil {
		h.Logf(f, a...)
	}
}

// POST /api/auth/code/send  { "email": "x@qq.com" }
//
// 两个 429 都是"带 retryAfter 的 429"：
//   - 60 s 冷却内重发       → retryAfter = 剩余秒数
//   - 每小时超过 10 次      → retryAfter = 距最早那次满一小时还有多少秒
//
// **发信失败不会消耗冷却**：写库失败/发不出去就回 502，用户可以立刻重试。
func (h *Handler) Send(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式不对")
		return
	}
	email := NormalizeEmail(req.Email)
	if !ValidEmail(email) {
		writeErr(w, http.StatusBadRequest, "邮箱格式不对")
		return
	}
	// 【核对轮】整段"查冷却 → 写码 → 发信 → 记一次"对同一邮箱串行，并发请求不能同时通过冷却检查。
	unlock, err := h.lock(r.Context(), "send:"+email)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "服务繁忙，请稍后再试")
		return
	}
	defer unlock()
	now := h.now()

	// ① 60 s 冷却
	if sends, err := h.Store.Sends(email, now.Add(-SendCooldown)); err == nil && len(sends) > 0 {
		left := int(math.Ceil(SendCooldown.Seconds() - now.Sub(sends[len(sends)-1]).Seconds()))
		if left < 1 {
			left = 1
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": fmt.Sprintf("发送太频繁，请 %d 秒后再试", left), "retryAfter": left,
		})
		return
	}

	// ② 每小时 10 次
	if sends, err := h.Store.Sends(email, now.Add(-time.Hour)); err == nil && len(sends) >= MaxSendPerHour {
		// 【核对轮】原实现用 time.Until（墙钟），与注入的 h.Now 不一致；统一用 now。
		left := int(math.Ceil(sends[0].Add(time.Hour).Sub(now).Seconds()))
		if left < 1 {
			left = 60
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "发送太频繁，请 1 小时后再试", "retryAfter": left,
		})
		return
	}

	// ③ 按来源 IP 限流（可选）。【核对轮】计数与占位在同一把 IP 锁里完成（并发不能超额），
	// 占位发生在发信之前：发信失败也算一次 IP 额度（防的是"同一出口刷很多邮箱"，失败也是在刷）。
	ip := clientIP(r, h.TrustedProxyHops)
	if h.MaxSendPerIPPerHour > 0 {
		ipUnlock, err := h.lock(r.Context(), "ip:"+ip)
		if err != nil {
			writeErr(w, http.StatusServiceUnavailable, "服务繁忙，请稍后再试")
			return
		}
		n, err := h.Store.CountSendsByIP(ip, now.Add(-time.Hour))
		if err == nil && n >= h.MaxSendPerIPPerHour {
			ipUnlock()
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error": "发送太频繁，请 1 小时后再试", "retryAfter": 3600,
			})
			return
		}
		_ = h.Store.RecordSendByIP(ip, now)
		ipUnlock()
	}

	code, err := GenCode()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "生成验证码失败，请稍后再试")
		return
	}
	// 【核对轮】记下旧码：这次发信失败时把仍在有效期内的旧码放回去，而不是连旧码一起删掉。
	prev, hadPrev, _ := h.Store.Get(email)
	rec := Record{Email: email, Code: code, IssuedAt: now, ExpiresAt: now.Add(CodeTTL)}
	if err = h.Store.Put(email, rec); err != nil {
		writeErr(w, http.StatusInternalServerError, "验证码保存失败，请稍后再试")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err = h.Sender.SendCode(ctx, email, code); err != nil {
		// 发失败就当没发生：不占冷却，用户可立刻重试
		if hadPrev && !prev.Consumed && now.Before(prev.ExpiresAt) {
			_ = h.Store.Put(email, prev)
		} else {
			_ = h.Store.Delete(email)
		}
		h.logf("[authcode] 发信失败 %s: %v", maskEmail(email), err)
		writeErr(w, http.StatusBadGateway, "验证码发送失败，请稍后再试")
		return
	}

	_ = h.Store.RecordSend(email, now)
	h.logf("[authcode] 已发码 %s", maskEmail(email))
	writeJSON(w, http.StatusOK, map[string]any{"cooldown": int(SendCooldown.Seconds())})
}

// POST /api/auth/code/login  { "email": "x@qq.com", "code": "123456" }
//
// 新邮箱验证成功即注册（服务端生成 玩家xxxx 昵称）。
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式不对")
		return
	}
	email := NormalizeEmail(req.Email)
	code := strings.TrimSpace(req.Code)
	if !ValidEmail(email) {
		writeErr(w, http.StatusBadRequest, "邮箱格式不对")
		return
	}
	if len(code) != CodeLen {
		writeErr(w, http.StatusBadRequest, "验证码不正确")
		return
	}
	// 【核对轮】"查次数 → 记一次 → 取码 → 比对 → 写回/作废"对同一邮箱串行：
	// 不加锁时并发请求都读到 Attempts=0、计数<20，60 个并发猜码能全部被比对，同一个正确码也能并发换出多个 key。
	unlock, err := h.lock(r.Context(), "verify:"+email)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "服务繁忙，请稍后再试")
		return
	}
	now := h.now()

	// 校验次数上限（含猜错的）：6 位码不限次数是能被暴力猜的
	if n, err := h.Store.CountVerify(email, now.Add(-time.Hour)); err == nil && n >= MaxVerifyPerHour {
		unlock()
		writeErr(w, http.StatusTooManyRequests, "验证太频繁，请 1 小时后再试")
		return
	}
	_ = h.Store.IncrVerify(email, now)

	rec, ok, err := h.Store.Get(email)
	if err != nil {
		unlock()
		writeErr(w, http.StatusInternalServerError, "校验失败，请稍后再试")
		return
	}
	if !ok || rec.Consumed {
		unlock()
		writeErr(w, http.StatusGone, "验证码已过期，请重新获取")
		return
	}
	if now.After(rec.ExpiresAt) {
		_ = h.Store.Delete(email)
		unlock()
		writeErr(w, http.StatusGone, "验证码已过期，请重新获取")
		return
	}
	if !codeEqual(rec.Code, code) {
		rec.Attempts++
		if rec.Attempts >= MaxVerifyAttempts {
			_ = h.Store.Delete(email) // 猜够次数就作废，逼用户重新获取
		} else {
			_ = h.Store.Put(email, rec)
		}
		unlock()
		writeErr(w, http.StatusBadRequest, "验证码不正确")
		return
	}

	// 通过：一次性使用，立刻作废（仍在锁内，第二个并发请求只会看到"没有码"→ 410）
	_ = h.Store.Delete(email)
	unlock()

	u, exists, err := h.Users.ByEmail(email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登录失败，请稍后再试")
		return
	}
	if exists {
		u, err = h.Users.IssueKey(u.ID)
	} else {
		u, err = h.Users.CreateForCode(email)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登录失败，请稍后再试")
		return
	}
	u.Email = email
	dev := strings.TrimSpace(r.Header.Get("X-Fong-Device"))
	if h.BindKey != nil {
		if err := h.BindKey(r, u); err != nil {
			h.logf("[authcode] 绑定设备失败 %s: %v", maskEmail(email), err)
			writeErr(w, http.StatusInternalServerError, "登录失败，请稍后再试")
			return
		}
	} else if h.OnKeyIssued != nil {
		// 兼容旧接法：失败不影响登录（不推荐，见 BindKey 的注释）
		func() {
			defer func() { _ = recover() }()
			h.OnKeyIssued(u.ID, u.Key, dev)
		}()
	}
	h.logf("[authcode] 登录成功 %s（%s）", maskEmail(email), map[bool]string{true: "老用户", false: "新注册"}[exists])
	writeJSON(w, http.StatusOK, u)
}

// maskEmail 日志里只留邮箱首字符与域名（a***@qq.com），避免日志变成邮箱清单。
func maskEmail(e string) string {
	at := strings.LastIndex(e, "@")
	if at <= 0 {
		return "***"
	}
	return e[:1] + "***" + e[at:]
}

// clientIP 取来源 IP。
//
// 【核对轮重写】hops = 前面可信反代的层数（Handler.TrustedProxyHops）：
//   - hops <= 0：只认 TCP 对端（RemoteAddr），忽略一切转发头 —— 客户端伪造的头无效；
//   - hops  > 0：取 X-Forwarded-For 从右往左第 hops 个（每层可信代理都往右追加一段，
//     最左边那些是客户端自己能随便填的）；XFF 段数不够时退回 RemoteAddr。
func clientIP(r *http.Request, hops int) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	if hops <= 0 {
		return remote
	}
	var parts []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
	}
	if len(parts) >= hops {
		if ip := net.ParseIP(parts[len(parts)-hops]); ip != nil {
			return ip.String()
		}
	}
	return remote
}
