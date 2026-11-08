package authcode

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"
)

// Sender 只做一件事：把这个验证码发到这个邮箱。换通道 = 换一个实现。
//
// 三个现成实现：
//   - LogSender   —— 写日志，本地/内测用（不真发信）
//   - SMTPSender  —— 标准 SMTP（587 STARTTLS / 465 隐式 TLS）
//   - HTTPSender  —— 厂商 HTTP API（POST 一个 JSON，替 {{to}}/{{code}}）
//
// 短信同理：实现 SendCode 调短信 API 即可，上层逻辑一个字都不用改。
type Sender interface {
	SendCode(ctx context.Context, to, code string) error
}

// ---------- 本地/内测 ----------

// LogSender 把验证码打到日志。生产**不要**用它（等于把验证码公开）。
type LogSender struct {
	Logf func(format string, args ...any)
}

func (s *LogSender) SendCode(_ context.Context, to, code string) error {
	if s.Logf != nil {
		s.Logf("[authcode] 验证码 → %s : %s（有效期 %s）", to, code, CodeTTL)
	}
	return nil
}

// ---------- SMTP ----------

// SMTPSender 走标准 SMTP。
//
// 端口选择很关键：**国内服务器 25 端口出站基本被封，不要用 25**。
//   - 587：STARTTLS（推荐，smtp.Dial 会自动升级）
//   - 465：隐式 TLS（ImplicitTLS=true，本实现自己包 tls.Dial）
type SMTPSender struct {
	Addr        string // host:port
	Host        string // 用于 TLS ServerName 与 AUTH（留空则从 Addr 里切）
	User        string
	Pass        string
	From        string // 发信地址，例如 no-reply@mail.fongget.xyz
	FromName    string // 显示名，例如 FONG
	ImplicitTLS bool   // 465 端口用 true
	Timeout     time.Duration

	// 【核对轮新增】
	HeloName       string // EHLO 用的本机名，建议填发信域名（如 mail.fongget.xyz）；留空用 "localhost"
	AllowPlaintext bool   // 587 上服务器不支持 STARTTLS 时是否允许明文继续（默认 false = 直接报错）
}

func (s *SMTPSender) host() string {
	if s.Host != "" {
		return s.Host
	}
	if i := strings.LastIndex(s.Addr, ":"); i > 0 {
		return s.Addr[:i]
	}
	return s.Addr
}

func (s *SMTPSender) SendCode(ctx context.Context, to, code string) error {
	to = NormalizeEmail(to)
	if !ValidEmail(to) {
		return fmt.Errorf("收件地址不合法")
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	host := s.host()
	msg := BuildMail(s.From, s.FromName, to, code)

	// 【核对轮】原实现 587 走 smtp.Dial：没有超时、不看 ctx，服务器不回包会一直挂住请求；
	// 服务器不支持 STARTTLS 时会静默走明文。现在：拨号带 ctx 与超时、整条连接设截止时间、默认强制 TLS。
	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	dialer := &net.Dialer{Timeout: timeout}
	raw, err := dialer.DialContext(ctx, "tcp", s.Addr)
	if err != nil {
		return fmt.Errorf("连不上邮件服务器(%s): %w", s.Addr, err)
	}
	_ = raw.SetDeadline(deadline)
	conn := raw
	tlsCfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if s.ImplicitTLS {
		tc := tls.Client(raw, tlsCfg)
		if err = tc.HandshakeContext(ctx); err != nil {
			raw.Close()
			return fmt.Errorf("TLS 握手失败(%s): %w", s.Addr, err)
		}
		conn = tc
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("连不上邮件服务器(%s): %w", s.Addr, err)
	}
	defer c.Close()
	helo := s.HeloName
	if helo == "" {
		helo = "localhost"
	}
	if err = c.Hello(helo); err != nil {
		return fmt.Errorf("EHLO 失败: %w", err)
	}

	if !s.ImplicitTLS {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err = c.StartTLS(tlsCfg); err != nil {
				return fmt.Errorf("STARTTLS 失败: %w", err)
			}
		} else if !s.AllowPlaintext {
			return fmt.Errorf("邮件服务器(%s)不支持 STARTTLS，拒绝明文发送", s.Addr)
		}
	}
	if s.User != "" {
		ok, _ := c.Extension("AUTH")
		if !ok {
			return fmt.Errorf("邮件服务器(%s)没有提供 AUTH，无法认证", s.Addr)
		}
		if err = c.Auth(smtp.PlainAuth("", s.User, s.Pass, host)); err != nil {
			return fmt.Errorf("SMTP 认证失败: %w", err)
		}
	}
	if err = c.Mail(s.From); err != nil {
		return fmt.Errorf("MAIL FROM 被拒: %w", err)
	}
	if err = c.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO 被拒（地址可能不存在）: %w", err)
	}
	wc, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA 失败: %w", err)
	}
	if _, err = wc.Write(msg); err != nil {
		return fmt.Errorf("写正文失败: %w", err)
	}
	if err = wc.Close(); err != nil {
		return fmt.Errorf("投递失败: %w", err)
	}
	return c.Quit()
}

// ---------- 厂商 HTTP API ----------

// HTTPSender 用厂商的 HTTP API 发信（阿里云邮件推送、腾讯云 SES、Resend、SendGrid 都行）。
//
// BodyTemplate 是一段 JSON 原文，里面用 {{to}} 和 {{code}} 占位（替换时会做 JSON 转义）。
// 例（Resend 风格）：
//
//	{"from":"FONG <no-reply@mail.fongget.xyz>","to":"{{to}}","subject":"FONG 登录验证码",
//	 "text":"你的验证码是 {{code}}，10 分钟内有效。"}
type HTTPSender struct {
	URL          string
	Headers      map[string]string
	BodyTemplate string
	Client       *http.Client
}

func (s *HTTPSender) SendCode(ctx context.Context, to, code string) error {
	to = NormalizeEmail(to)
	if !ValidEmail(to) {
		return fmt.Errorf("收件地址不合法")
	}
	body := strings.NewReplacer(
		"{{to}}", jsonEscape(to),
		"{{code}}", jsonEscape(code),
	).Replace(s.BodyTemplate)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.URL, bytes.NewReader([]byte(body)))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json; charset=utf-8")
	for k, v := range s.Headers {
		req.Header.Set(k, v)
	}
	cl := s.Client
	if cl == nil {
		cl = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return fmt.Errorf("调用发信接口失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("发信接口返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func jsonEscape(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return ""
	}
	return string(b[1 : len(b)-1]) // 去掉两端引号，嵌入到已有引号里
}

// BuildMail 组装一封纯文本邮件。
//
// 刻意**不用 HTML**：纯文本更难被判垃圾邮件，也不带任何追踪像素与链接。
// 正文只说事：谁、多久有效、不是本人就忽略。
func BuildMail(from, fromName, to, code string) []byte {
	var b bytes.Buffer
	if fromName == "" {
		fromName = "FONG"
	}
	fmt.Fprintf(&b, "From: %s <%s>\r\n", mimeEncode(fromName), from)
	fmt.Fprintf(&b, "To: <%s>\r\n", to)
	b.WriteString("Subject: " + mimeEncode("FONG 登录验证码") + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("Auto-Submitted: auto-generated\r\n") // 告诉收件方这是自动邮件
	b.WriteString("\r\n")
	fmt.Fprintf(&b, "你的登录验证码是：\r\n\r\n    %s\r\n\r\n", code)
	fmt.Fprintf(&b, "%d 分钟内有效，只能使用一次。\r\n", int(CodeTTL.Minutes()))
	b.WriteString("如果这不是你本人的操作，忽略本邮件即可，你的账号不会受影响。\r\n\r\n")
	b.WriteString("—— FONG\r\n")
	return b.Bytes()
}

// mimeEncode 只在含非 ASCII 时才做 RFC 2047 编码（中文主题/显示名必须编码，否则乱码）。
func mimeEncode(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			return "=?UTF-8?B?" + b64(s) + "?="
		}
	}
	return s
}

func b64(s string) string {
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	src := []byte(s)
	var out []byte
	for i := 0; i < len(src); i += 3 {
		var n uint32
		rem := len(src) - i
		n = uint32(src[i]) << 16
		if rem > 1 {
			n |= uint32(src[i+1]) << 8
		}
		if rem > 2 {
			n |= uint32(src[i+2])
		}
		out = append(out, tbl[(n>>18)&63], tbl[(n>>12)&63])
		if rem > 1 {
			out = append(out, tbl[(n>>6)&63])
		} else {
			out = append(out, '=')
		}
		if rem > 2 {
			out = append(out, tbl[n&63])
		} else {
			out = append(out, '=')
		}
	}
	return string(out)
}
