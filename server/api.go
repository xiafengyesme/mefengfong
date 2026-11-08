package main

// 控制面：空间 / 房间 / 成员 / 权限 / 在线状态。
// 只新增 /api/* 接口，PRD 5.1 的 /signal /events /answer /healthz 契约不变。

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"fong/server/auth"
	"unicode/utf8"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

type User struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	KeyHash   string `json:"keyHash"`
	Email     string `json:"email,omitempty"`
	PassHash  string `json:"passHash,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
	// 多设备：主 KeyHash 之外的额外 key 哈希（最多 maxExtraKeys 个）。
	// 登录不再换发主 key，而是追加一个，这样手机登录不会把电脑踢掉。
	ExtraKeys []string `json:"extraKeys,omitempty"`
	// 头像：data:image/...（base64，≤32KB）或纯色值。
	// 和空间图标一样内联存进 JSON，不搞文件存储 ——
	// 这样备份/迁移只要拷一个 fong.json，也不会出现「头像文件丢了」。
	Avatar string `json:"avatar,omitempty"`
	// 设备表（auth 增量）：一个 key 绑一台设备，最多 5 台，FIFO 淘汰。
	Devices []devRec `json:"devices,omitempty"`
	// 已吊销 key 的墓碑：keyHash -> reason（evicted / password）。
	// 只用来给 401 区分原因，丢了最坏是 unknown。
	Tombs map[string]string `json:"tombs,omitempty"`
}

type SpaceMember struct {
	Role     Role  `json:"role"`
	JoinedAt int64 `json:"joinedAt"`
}

// 【0.4.66】封禁记录。存 SpaceRec.Banned 里，与 Members 解耦。
type BanRecord struct {
	By     string `json:"by"`               // 谁封的
	At     int64  `json:"at"`               // 何时封的
	Reason string `json:"reason,omitempty"` // 可选理由
}

type RoomRec struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// voice = 语音频道（默认，空值按 voice 处理，兼容老数据）
	// text  = 文字频道
	Kind     string `json:"kind,omitempty"`
	Pinned   bool   `json:"pinned"`
	MaxUsers int    `json:"maxUsers"`
	Order    int64  `json:"order"`
	// 【0.4.67】频道密码（只存 hash，明文进库就是事故）。
	// 与 KOOK 对齐：设了密码的频道，非管理员进入前要输一次；
	// 管理员（owner/admin）免密 —— 和 KOOK 的「你没有权限加入该频道」
	// 与「加密频道需密码(40310)」两条文案的分工一致。
	// 【安全】json:"-" —— 绝不出现在任何 API 响应里。
	// roomView 内嵌了 *RoomRec，不加 "-" 会把 hash 一起发给所有客户端（实测确认过）。
	PasswordHash string `json:"-"`
}

// HasPassword 供 view 用：只回报「有没有密码」，绝不把 hash 发出去。
func (r *RoomRec) HasPassword() bool { return r.PasswordHash != "" }

// checkRoomPassword 校验频道密码。管理员免密。
// 返回 nil = 放行；返回 error = 拒绝（由调用方决定回什么码）。
func checkRoomPassword(room *RoomRec, role Role, given string) error {
	if room.PasswordHash == "" {
		return nil // 没设密码
	}
	if role == RoleOwner || role == RoleAdmin {
		return nil // 管理员免密
	}
	if given == "" {
		return failR(403, "这个频道需要密码", "ROOM_PASSWORD")
	}
	if subtle.ConstantTimeCompare([]byte(hashKey(given)), []byte(room.PasswordHash)) != 1 {
		return failR(403, "频道密码不对", "ROOM_PASSWORD_WRONG")
	}
	return nil
}

type SpaceRec struct {
	ID        string                  `json:"id"`
	JoinCode  string                  `json:"joinCode,omitempty"` // 6 位易读码，取代长 hex
	Name      string                  `json:"name"`
	Icon      string                  `json:"icon,omitempty"` // 色值或 data:image/...（≤64KB）
	OwnerID   string                  `json:"ownerId"`
	CreatedAt int64                   `json:"createdAt"`
	MaxUsers  int                     `json:"maxUsers"`
	Rooms     []*RoomRec              `json:"rooms"`
	Members   map[string]*SpaceMember `json:"members"`
	// 【0.4.66】封禁表。刻意与 Members 解耦：
	// apiKick 会 delete(sp.Members, target)，如果封禁标记挂在 SpaceMember 上，
	// 一次"移出房间"就把封禁清掉了 —— 被封者下次 join 直接恢复。
	Banned map[string]*BanRecord `json:"banned,omitempty"`
	// 服务端静音是**频道级**的：静音只在这个频道里生效，换到别的频道照常能说话。
	// 键是频道 id（RoomRec.ID），值是 "这个频道里被静音的人"。
	// 之前这里是 map[uid]bool（空间级），那等于「在空间里禁止发言」——
	// 那是另一种东西（封禁/禁言），不是静音。
	MutedByRoom map[string]map[string]bool `json:"mutedByRoom,omitempty"`
}

// 文字频道的消息。seq 是频道内自增序号，客户端拿它做增量拉取的游标 ——
// 不用时间戳，因为同一毫秒可能来好几条，时间戳会漏。
type Msg struct {
	Seq     int64  `json:"seq"`
	UID     string `json:"uid"`
	Name    string `json:"name"`
	Text    string `json:"text"`
	Img     string `json:"img,omitempty"` // 图片：/img/<随机id>.<ext>，文件本体在 data/img（OOPZ/KOOK 式频道内截图）
	Deleted bool   `json:"deleted,omitempty"`
	Edited  bool   `json:"edited,omitempty"` // 【0.4.38】编辑过 → 前端显示「(已编辑)」（KOOK 的 message_ededstr）
	// 【0.4.49】通用文件（KOOK upload_zipbtn / OOPZ「发送文件」）。
	// 与 Img 分开：图片内联预览，普通文件只显示文件名+大小+下载。
	File     *FileRef            `json:"file,omitempty"`
	Reaction map[string][]string `json:"reaction,omitempty"` // emoji -> [uid...]（表情回应）
	SentAt   int64               `json:"sentAt"`
}

// 【0.4.38】搜索命中：带上频道 id，前端才能显示「消息来自哪个频道」
type searchHit struct {
	Rid string `json:"rid"`
	*Msg
}

// 【0.4.49】文件引用：name 是服务端随机名（不可枚举），fname 是用户看到的原始文件名。
type FileRef struct {
	URL  string `json:"url"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mime string `json:"mime,omitempty"`
}

const maxFileBytes = 25 * 1024 * 1024 // 单文件 25 MB（KOOK 免费档同级）

// 每个频道保留最近这么多条（文字和截图共用额度）
const maxMsgsPerRoom = 200

type Presence struct {
	SelfMuted bool   `json:"selfMuted"`
	Deafened  bool   `json:"deafened"`
	Speaking  bool   `json:"speaking"`
	Playing   string `json:"playing,omitempty"` // 正在玩：客户端上报的前台程序名（KOOK/OOPZ 式）
	Seen      int64  `json:"-"`
}

type store struct {
	mu     sync.Mutex
	Users  map[string]*User     `json:"users"`
	Spaces map[string]*SpaceRec `json:"spaces"`
	// 邮箱 -> uid，用于登录查找（大小写不敏感，存小写）
	Emails map[string]string `json:"emails"`
	// "spaceID:roomID" -> 该频道最近的消息
	Messages map[string][]*Msg `json:"messages,omitempty"`
	path     string
	presence map[string]*Presence // peerID -> 状态
	version  map[string]int64     // spaceID -> 版本号（长轮询用）
	waiters  map[string][]chan struct{}
	dirty    bool
}

var db = &store{Users: map[string]*User{}, Spaces: map[string]*SpaceRec{}, presence: map[string]*Presence{},
	version: map[string]int64{}, waiters: map[string][]chan struct{}{},
	Emails: map[string]string{}, Messages: map[string][]*Msg{}}

// uid -> 最后一次带鉴权请求的 unix 秒（内存态，重启清零，不入库）。
// 「在线」= 客户端还开着（长轮询/心跳在跑）；「在哪个语音房」看房间 members，两回事。
var lastSeenMu sync.Mutex
var lastSeen = map[string]int64{}

// 长轮询挂起 + 网络抖动的余量；超过就算离线
const onlineWindow = 120

func onlineOf(uid string) bool {
	lastSeenMu.Lock()
	defer lastSeenMu.Unlock()
	return time.Now().Unix()-lastSeen[uid] < onlineWindow
}

var allowLegacyRooms bool

// 客户端安装包目录。设置后开放 /dl/{file} 与 /api/releases。
var dlDir string

// 落地页目录。设置后 GET / 返回 index.html。
var webDir string

func loadStore(path string) {
	db.path = path
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, db); err != nil {
			log.Fatalf("读取 %s 失败: %v", path, err)
		}
	}
	if db.Users == nil {
		db.Users = map[string]*User{}
	}
	if db.Spaces == nil {
		db.Spaces = map[string]*SpaceRec{}
	}
	if db.Emails == nil {
		db.Emails = map[string]string{}
	}
	if db.Messages == nil {
		db.Messages = map[string][]*Msg{}
	}
	// 迁移：老数据只有 KeyHash + ExtraKeys，没有设备表。
	// 这里把每个 key 变成一台设备（设备号由 key 派生，稳定且不重复），
	// 之后所有鉴权都只认设备表，两条路径不会再分叉。
	migrated := 0
	for _, u := range db.Users {
		if len(u.Devices) > 0 || u.KeyHash == "" {
			continue
		}
		seq := int64(0)
		add := func(h string) {
			if h == "" {
				return
			}
			seq++
			u.Devices = append(u.Devices, devRec{
				ID: auth.NormalizeDeviceID("", h), KeyHash: h,
				Name: "旧设备", App: "FONG", Seq: seq,
				LastActive: time.Now().Unix(),
			})
		}
		add(u.KeyHash)
		for _, k := range u.ExtraKeys {
			add(k)
		}
		u.ExtraKeys = nil
		migrated++
	}
	if migrated > 0 {
		db.dirty = true
		log.Printf("[auth] 设备表迁移 %d 个账号", migrated)
	}
	// 迁移出来的设备没有活跃时间，补成当前时间，免得设备列表显示「时间未知」
	fixed := 0
	for _, u := range db.Users {
		for i := range u.Devices {
			if u.Devices[i].LastActive == 0 {
				u.Devices[i].LastActive = time.Now().Unix()
				fixed++
			}
		}
	}
	if fixed > 0 {
		db.dirty = true
		log.Printf("[auth] 补齐 %d 台设备的活跃时间", fixed)
	}
	go func() {
		for range time.Tick(2 * time.Second) {
			db.mu.Lock()
			if db.dirty {
				db.dirty = false
				b, _ := json.MarshalIndent(db, "", " ")
				tmp := db.path + ".tmp"
				if err := os.MkdirAll(filepath.Dir(db.path), 0o755); err == nil {
					if os.WriteFile(tmp, b, 0o600) == nil {
						os.Rename(tmp, db.path)
					}
				}
			}
			db.mu.Unlock()
		}
	}()
}

// bump 必须在持有 db.mu 时调用
func (s *store) bump(spaceID string) {
	s.version[spaceID]++
	for _, c := range s.waiters[spaceID] {
		close(c)
	}
	delete(s.waiters, spaceID)
	s.dirty = true
}

// 房间里有人进出、静音等变化时由 SFU 调用
func notifyRoomKey(roomKey string) {
	sid, _, ok := strings.Cut(roomKey, ":")
	if !ok {
		return
	}
	db.mu.Lock()
	if _, ok := db.Spaces[sid]; ok {
		db.bump(sid)
	}
	db.mu.Unlock()
}

func newID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// 人类友好房间号：去掉容易看错的 0/O、1/I/L
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

func newJoinCode(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = codeAlphabet[randInt(len(codeAlphabet))]
	}
	return string(b)
}

func randInt(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return int(time.Now().UnixNano() % int64(n))
	}
	return int(v.Int64())
}

// 房间号唯一性：撞了就重试（32^6 ≈ 10.7 亿，实际几乎不会撞）
func uniqueJoinCode() string {
	for i := 0; i < 20; i++ {
		c := newJoinCode(6)
		dup := false
		for _, sp := range db.Spaces {
			if sp.JoinCode == c {
				dup = true
				break
			}
		}
		if !dup {
			return c
		}
	}
	return newJoinCode(6)
}

// 密码用 PBKDF2-SHA256（Go 1.24+ 标准库，无需第三方依赖）
const pbkdf2Iter = 120000

func hashPassword(pass string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, pass, salt, pbkdf2Iter, 32)
	if err != nil {
		return ""
	}
	return base64.RawStdEncoding.EncodeToString(salt) + "$" +
		base64.RawStdEncoding.EncodeToString(key)
}

func verifyPassword(pass, stored string) bool {
	i := strings.IndexByte(stored, '$')
	if i <= 0 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(stored[:i])
	want, err2 := base64.RawStdEncoding.DecodeString(stored[i+1:])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pass, salt, pbkdf2Iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// 邮箱规范：小写去空格，做基本格式检查
func normEmail(e string) (string, error) {
	e = strings.ToLower(strings.TrimSpace(e))
	if len(e) < 5 || len(e) > 254 {
		return "", fail(400, "邮箱格式不对")
	}
	at := strings.LastIndexByte(e, '@')
	if at < 1 || at == len(e)-1 || !strings.Contains(e[at:], ".") {
		return "", fail(400, "邮箱格式不对")
	}
	// 拒绝空白和控制字符（用字符码判断，避免转义字符被工具链吃掉）
	for _, r := range e {
		if r <= ' ' || r == 0x7f || r == '<' || r == '>' {
			return "", fail(400, "邮箱格式不对")
		}
	}
	return e, nil
}

// 登录成功时换发新 key（服务端只存 hash，无法反推旧 key）
func issueKey() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func hashKey(k string) string {
	h := sha256.Sum256([]byte("fong:" + k))
	return hex.EncodeToString(h[:])
}

func cleanName(s string, max int) (string, error) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	if n < 1 || n > max {
		return "", fmt.Errorf("名字需要 1-%d 个字", max)
	}
	return s, nil
}

// ---------- 鉴权 ----------

type apiErr struct {
	code   int
	msg    string
	reason string // 401 时给客户端区分原因（evicted / password / unknown）
}

func (e apiErr) Error() string { return e.msg }

func fail(code int, msg string) error { return apiErr{code: code, msg: msg} }

// 【0.4.66】带 reason 的错误。客户端据此区分"被封禁"(BANNED) 与"不是成员"(NOT_MEMBER) ——
// 两者都是 403，不带 reason 的话负向测试分不开，写了等于没写。
func failR(code int, msg, reason string) error {
	return apiErr{code: code, msg: msg, reason: reason}
}

func authUser(r *http.Request) (*User, error) {
	u, _, err := authUserDev(r)
	if err == nil && u != nil {
		// 叶子锁：调用方可能正握着 db.mu（如 apiSendMessage / checkJoin），这里绝不能再拿 db.mu
		lastSeenMu.Lock()
		lastSeen[u.ID] = time.Now().Unix()
		lastSeenMu.Unlock()
	}
	return u, err
}

// 给账号追加一个设备 key。超出上限时丢弃最早的那个（FIFO）。
// keyAccepted 判断这个 key 是否属于该账号：主 key 或任一设备 key。
// 登录会换发设备 key（服务端只存 hash，无法反推），客户端启动时用这个 key
// 重新 /api/register。如果这里只认主 key，表现就是「登录成功 → 重启又要求登录」，
// 而且每次登录都会新增一个设备 key，用户会陷入反复点登录的死循环。
func keyAccepted(u *User, key string) bool {
	kh := hashKey(key)
	if subtle.ConstantTimeCompare([]byte(u.KeyHash), []byte(kh)) == 1 {
		return true
	}
	for _, ek := range u.ExtraKeys {
		if subtle.ConstantTimeCompare([]byte(ek), []byte(kh)) == 1 {
			return true
		}
	}
	return false
}

const maxExtraKeys = 4

func addDeviceKey(u *User, key string) {
	kh := hashKey(key)
	if subtle.ConstantTimeCompare([]byte(u.KeyHash), []byte(kh)) == 1 {
		return // 和主 key 相同，不用加
	}
	for _, ek := range u.ExtraKeys {
		if subtle.ConstantTimeCompare([]byte(ek), []byte(kh)) == 1 {
			return // 已有，不重复
		}
	}
	u.ExtraKeys = append(u.ExtraKeys, kh)
	if len(u.ExtraKeys) > maxExtraKeys {
		u.ExtraKeys = u.ExtraKeys[len(u.ExtraKeys)-maxExtraKeys:]
	}
}

func roleOf(sp *SpaceRec, uid string) Role {
	if m := sp.Members[uid]; m != nil {
		return m.Role
	}
	return ""
}

func canManage(sp *SpaceRec, uid string) bool {
	r := roleOf(sp, uid)
	return r == RoleOwner || r == RoleAdmin
}

// peerID 约定：<uid>.<会话随机串>
func uidOfPeer(peer string) string { u, _, _ := strings.Cut(peer, "."); return u }

// 供 /signal 调用：校验能否进入该房间。返回 nil 表示放行。
func checkJoin(r *http.Request, roomKey, peerID string, isNew bool) error {
	sid, rid, ok := strings.Cut(roomKey, ":")
	db.mu.Lock()
	defer db.mu.Unlock()
	sp := db.Spaces[sid]
	if !ok || sp == nil {
		if allowLegacyRooms {
			return nil
		}
		return fail(404, "房间不存在")
	}
	u, err := authUser(r)
	if err != nil {
		return err
	}
	if uidOfPeer(peerID) != u.ID {
		return fail(403, "身份不匹配")
	}
	if roleOf(sp, u.ID) == "" {
		return fail(403, "你不在这个空间里")
	}
	var room *RoomRec
	for _, x := range sp.Rooms {
		if x.ID == rid {
			room = x
		}
	}
	if room == nil {
		return fail(404, "房间已被删除")
	}
	if isNew {
		// 【0.4.67】频道密码：只在「新进入」时校验。
		// 已在房里的人不重复验 —— 否则管理员中途设密码会把房里的人踢出去。
		// 密码从 query 取（/signal?pw=xxx），与 KOOK 的 40310 → 弹框 → 带密码重试一致。
		if err := checkRoomPassword(room, roleOf(sp, u.ID), r.URL.Query().Get("pw")); err != nil {
			return err
		}
		live := len(livePeers(roomKey))
		if live >= room.MaxUsers {
			return fail(409, fmt.Sprintf("房间已满（%d/%d）", live, room.MaxUsers))
		}
	}
	return nil
}

// currentRoomOf 返回该用户此刻所在的频道 id（用于老客户端没传 room 时兜底）。
func currentRoomOf(sp *SpaceRec, uid string) string {
	for _, r := range sp.Rooms {
		if len(livePeers(sp.ID+":"+r.ID)) == 0 {
			continue
		}
		// 该频道里有属于这个 uid 的 peer，就算他在这个频道
		for _, p := range livePeers(sp.ID + ":" + r.ID) {
			if uidOfPeer(p) == uid {
				return r.ID
			}
		}
	}
	return ""
}

func isServerMuted(roomKey, peerID string) bool {
	sid, rid, _ := strings.Cut(roomKey, ":")
	db.mu.Lock()
	defer db.mu.Unlock()
	sp := db.Spaces[sid]
	if sp == nil {
		return false
	}
	room := sp.MutedByRoom[rid]
	return room != nil && room[uidOfPeer(peerID)]
}

// ---------- 视图 ----------

type memberView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      Role   `json:"role"`
	Peer      string `json:"peer,omitempty"`
	Muted     bool   `json:"muted"`
	SelfMuted bool   `json:"selfMuted"`
	Deafened  bool   `json:"deafened"`
	Speaking  bool   `json:"speaking"`
	JoinedAt  int64  `json:"joinedAt,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
	Online    bool   `json:"online"` // 软件开着（120 秒内有心跳）
	Playing   string `json:"playing,omitempty"`
	// 【0.4.66】这个人是否被封禁。
	// 注意与 spaceView.Banned 是两个不同语义，别混：
	//   spaceView.Banned  = 我（访问者）被封了       → 前端跳封禁页
	//   memberView.Banned = 这个成员被封了           → 渲染标记 + 给管理员显示「解除封禁」
	// 没有这个字段，管理员打开成员列表看不出谁被封、也不知道「解除封禁」该挂谁身上，
	// Q3 定的「成员列表同时就是封禁列表」就落不了地。
	Banned bool `json:"banned,omitempty"`
}

// roomView 显式列出要外发的字段，【不内嵌 RoomRec】。
//
// 【为什么不用内嵌】内嵌是 default-allow：RoomRec 以后每加一个字段都会自动
// 出现在 API 响应里，靠人记得加 `json:"-"`。0.4.67 加 PasswordHash 时就是这么漏的
// （当时 tag 写成了 json:"passwordHash"，hash 直接发给所有客户端）。
// 改成显式列表后，新字段默认不外发，要外发必须显式加一行 —— 这个方向的默认值才安全。
//
// 注意：内嵌本身是遵守 tag 的（实测 json:"-" 对内嵌字段生效，指针和值都有效），
// 换成显式列表不是修 bug，是换默认方向。
type roomView struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Kind        string       `json:"kind"`
	Pinned      bool         `json:"pinned"`
	MaxUsers    int          `json:"maxUsers"`
	Order       int64        `json:"order"`
	HasPassword bool         `json:"hasPassword,omitempty"`
	SpaceID     string       `json:"spaceId"`
	Online      []memberView `json:"members"`
}

type spaceView struct {
	ID        string       `json:"id"`
	JoinCode  string       `json:"joinCode,omitempty"`
	Name      string       `json:"name"`
	Icon      string       `json:"icon,omitempty"`
	OwnerID   string       `json:"ownerId"`
	CreatedAt int64        `json:"createdAt"`
	MaxUsers  int          `json:"maxUsers"`
	MyRole    Role         `json:"myRole"`
	Banned    bool         `json:"banned,omitempty"` // 【0.4.66】当前访问者是否被封禁
	Version   int64        `json:"version"`
	Rooms     []roomView   `json:"rooms"`
	Members   []memberView `json:"members"`
}

func livePeers(roomKey string) []string {
	roomsMu.RLock()
	r := rooms[roomKey]
	roomsMu.RUnlock()
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.peers))
	for id := range r.peers {
		out = append(out, id)
	}
	return out
}

func (s *store) view(sp *SpaceRec, me string) spaceView {
	isMember := sp.Members[me] != nil
	isBanned := sp.Banned != nil && sp.Banned[me] != nil

	// 【0.4.66 · 隐私】被封禁的【非成员】：只给"你被封了"这一个状态，不给空间内容。
	//
	// 起因：apiGetSpace 用 accessMemberOrBanned 放行被封禁者（让他能看到"我被封了"），
	// 但它是【长轮询】—— 只要版本号变了就推。一个因骚扰被封的人可以每 25 秒拉一次，
	// 实时看到谁在线、有哪些频道、成员名单变化。人进不来，却可以一直观察，
	// 这基本抵消了封禁的意义。
	//
	// 【条件只看 isBanned，不看 isMember】
	// 初版写的是 `isBanned && !isMember` —— 但封禁【刻意不删 Members】，
	// 所以被封者永远是 isMember=true，那个条件一次都没成立过。
	// canary 实测：被封禁者仍能读到 members=3 / rooms=2，等于封禁只挡住了写、
	// 没挡住"持续观察"。这正是这条隐私裁剪要解决的问题。
	if isBanned {
		return spaceView{ID: sp.ID, Name: sp.Name, Banned: true}
	}

	// 房间号只给成员看，避免任何人枚举
	code := ""
	if isMember {
		code = sp.JoinCode
	}
	v := spaceView{ID: sp.ID, JoinCode: code, Name: sp.Name, Icon: sp.Icon, OwnerID: sp.OwnerID,
		CreatedAt: sp.CreatedAt,
		MaxUsers:  sp.MaxUsers, MyRole: roleOf(sp, me), Version: s.version[sp.ID],
		// 此处恒为 false：被封禁者在上面的裁剪分支就已经 return 了，走不到这里。
		// 【保留是为了结构完整，不要误以为是"裁剪失效"的原因】—— 排查时容易在这里绕半天。
		Banned: false}
	rs := append([]*RoomRec(nil), sp.Rooms...)
	sort.SliceStable(rs, func(i, j int) bool {
		if rs[i].Pinned != rs[j].Pinned {
			return rs[i].Pinned
		}
		return rs[i].Order < rs[j].Order
	})
	for _, r := range rs {
		kind := r.Kind
		if kind == "" {
			kind = "voice"
		}
		rv := roomView{
			ID: r.ID, Name: r.Name, Kind: kind, Pinned: r.Pinned,
			MaxUsers: r.MaxUsers, Order: r.Order,
			HasPassword: r.HasPassword(), SpaceID: sp.ID, Online: []memberView{},
		}
		peers := livePeers(sp.ID + ":" + r.ID)
		sort.Strings(peers)
		for _, p := range peers {
			uid := uidOfPeer(p)
			mv := memberView{ID: uid, Peer: p, Role: roleOf(sp, uid), Muted: sp.MutedByRoom[r.ID][uid]}
			if u := s.Users[uid]; u != nil {
				mv.Name, mv.Avatar = u.Name, u.Avatar
			}
			if pr := s.presence[p]; pr != nil {
				mv.SelfMuted, mv.Deafened, mv.Speaking = pr.SelfMuted, pr.Deafened, pr.Speaking
				mv.Playing = pr.Playing
			}
			rv.Online = append(rv.Online, mv)
		}
		v.Rooms = append(v.Rooms, rv)
	}
	for uid, m := range sp.Members {
		// 空间成员列表不报 muted：静音是频道级的，这里没有"当前频道"的语境
		mv := memberView{ID: uid, Role: m.Role, JoinedAt: m.JoinedAt, Online: onlineOf(uid),
			Banned: sp.Banned != nil && sp.Banned[uid] != nil}
		if u := s.Users[uid]; u != nil {
			mv.Name, mv.Avatar = u.Name, u.Avatar
		}
		v.Members = append(v.Members, mv)
	}
	rank := map[Role]int{RoleOwner: 0, RoleAdmin: 1, RoleMember: 2}
	sort.Slice(v.Members, func(i, j int) bool {
		if rank[v.Members[i].Role] != rank[v.Members[j].Role] {
			return rank[v.Members[i].Role] < rank[v.Members[j].Role]
		}
		return v.Members[i].JoinedAt < v.Members[j].JoinedAt
	})
	return v
}

// ---------- 路由 ----------

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// 【0.4.49】X-Fong-Filename / X-Fong-Mime 必须列进来。
		// 这两个是文件上传用的自定义头：浏览器会把带自定义头的 POST 判成「非简单请求」先发 OPTIONS 预检，
		// 预检响应里没这个头名 → 请求直接被拒，前端只看到 "Failed to fetch"（实测踩到，
		// 不带该头的小文件上传正常 200，一带就必然失败）。
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Fong-Uid, X-Fong-Key, X-Fong-Device, X-Fong-Filename, X-Fong-Mime, X-Fong-Size, X-Fong-Test")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition")
		// 【0.4.67】测试流量互锁：生产服务拒绝带 X-Fong-Test 头的请求。
		// 放在 OPTIONS 之后（预检要能过），真正处理之前。
		if r.Method != http.MethodOptions && rejectTestTraffic(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var ae apiErr
	if errors.As(err, &ae) {
		if ae.reason != "" {
			writeJSON(w, ae.code, map[string]string{"error": ae.msg, "reason": ae.reason})
			return
		}
		writeJSON(w, ae.code, map[string]string{"error": ae.msg})
		return
	}
	writeJSON(w, 500, map[string]string{"error": err.Error()})
}

func body(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 128<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return fail(400, "请求格式错误")
	}
	return nil
}

// ---------- 文字频道 ----------

func msgKey(sid, rid string) string { return sid + ":" + rid }

func roomOf(sp *SpaceRec, rid string) *RoomRec {
	for _, r := range sp.Rooms {
		if r.ID == rid {
			return r
		}
	}
	return nil
}

// POST /api/spaces/{sid}/rooms/{rid}/messages  {text, img}
// 语音频道和文字频道都能发 —— 频道内置聊天（OOPZ/KOOK 式），不再按 kind 拦
func apiSendMessage(w http.ResponseWriter, r *http.Request) {
	// 【0.4.49】接受通用文件（file 只允许本服务上传返回的 /file/ 路径）
	var req struct {
		Text, Img string
		File      *FileRef
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	text := strings.TrimSpace(req.Text)
	img := strings.TrimSpace(req.Img)
	var file *FileRef
	if req.File != nil && req.File.URL != "" {
		if len(req.File.URL) > 64 || !strings.HasPrefix(req.File.URL, "/file/") {
			writeErr(w, fail(400, "文件链接不合法"))
			return
		}
		f := *req.File
		f.Name = strings.TrimSpace(f.Name)
		if f.Name == "" {
			f.Name = "未命名文件"
		}
		if rn := []rune(f.Name); len(rn) > 120 {
			f.Name = string(rn[:120])
		}
		if f.Size < 0 || f.Size > maxFileBytes {
			f.Size = 0
		}
		file = &f
	}
	if text == "" && img == "" && file == nil {
		writeErr(w, fail(400, "消息不能是空的"))
		return
	}
	// 按 rune 计数，中文才不会被算成 3 倍
	if utf8.RuneCountInString(text) > 2000 {
		writeErr(w, fail(400, "消息太长了（上限 2000 字）"))
		return
	}
	// img 只允许本服务生成的 /img/ 路径，防外链注入
	if img != "" && (len(img) > 256 || !strings.HasPrefix(img, "/img/")) {
		writeErr(w, fail(400, "图片链接不合法"))
		return
	}

	db.mu.Lock()
	defer db.mu.Unlock()
	// needMember=true：不是成员就不能往别人房间里发消息
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	rm := roomOf(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}

	key := msgKey(sp.ID, rm.ID)
	list := db.Messages[key]
	var seq int64 = 1
	if n := len(list); n > 0 {
		seq = list[n-1].Seq + 1
	}
	m := &Msg{Seq: seq, UID: u.ID, Name: u.Name, Text: text, Img: img, File: file, SentAt: time.Now().UnixMilli()}
	db.Messages[key] = append(list, m)
	if len(db.Messages[key]) > maxMsgsPerRoom {
		db.Messages[key] = db.Messages[key][len(db.Messages[key])-maxMsgsPerRoom:]
	}
	// 唤醒这个空间的长轮询，其他成员立刻就能拉到这条消息 ——
	// 不用客户端定时器，省掉每秒一次的固定请求。
	db.bump(sp.ID)
	writeJSON(w, 200, m)
}

// 发截图限流：正常聊天远远够，挡连拍刷屏
var rlImg = newLimiter(30, time.Minute)
var rlFile = newLimiter(20, time.Minute)
var rlBan = newLimiter(30, time.Minute) // 封禁/解封：管理员手速够用，防脚本

// 【0.4.38】PATCH /api/spaces/{sid}/rooms/{rid}/messages/{seq} —— 编辑自己的消息。
// KOOK 有 message_reeditbtn、OOPZ 有「支持编辑自己发送的消息」；FONG 之前只有撤回没有编辑。
func apiEditMessage(w http.ResponseWriter, r *http.Request) {
	var req struct{ Text string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		writeErr(w, fail(400, "消息不能是空的（想删就撤回）"))
		return
	}
	if utf8.RuneCountInString(text) > 2000 {
		writeErr(w, fail(400, "消息太长了（上限 2000 字）"))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	rm := roomOf(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil || seq <= 0 {
		writeErr(w, fail(400, "seq 不合法"))
		return
	}
	for _, m := range db.Messages[msgKey(sp.ID, rm.ID)] {
		if m.Seq != seq {
			continue
		}
		// 只有本人能编辑（管理员也不行：编辑是「改自己说过的话」，不是管理动作）
		if m.UID != u.ID {
			writeErr(w, fail(403, "只能编辑自己的消息"))
			return
		}
		if m.Deleted {
			writeErr(w, fail(400, "这条已经撤回了，不能编辑"))
			return
		}
		if m.Text == text {
			writeJSON(w, 200, m) // 没改就不打 Edited 标记
			return
		}
		m.Text = text
		m.Edited = true
		db.bump(sp.ID)
		writeJSON(w, 200, m)
		return
	}
	writeErr(w, fail(404, "消息不存在"))
}

// 【0.4.38】GET /api/spaces/{sid}/search?q=xxx —— 本空间内消息搜索（KOOK search_* / OOPZ 搜索）。
// 从最新往旧扫，最多 50 条命中；只搜纯文本，跳过已撤回。
func apiSearchMessages(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, []searchHit{})
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	_, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	lq := strings.ToLower(q)
	hits := make([]searchHit, 0, 50)
	for _, rm := range sp.Rooms {
		list := db.Messages[msgKey(sp.ID, rm.ID)]
		for i := len(list) - 1; i >= 0 && len(hits) < 50; i-- {
			m := list[i]
			if m.Deleted || m.Text == "" {
				continue
			}
			if strings.Contains(strings.ToLower(m.Text), lq) {
				hits = append(hits, searchHit{Rid: rm.ID, Msg: m})
			}
		}
		if len(hits) >= 50 {
			break
		}
	}
	writeJSON(w, 200, hits)
}

// DELETE /api/spaces/{sid}/rooms/{rid}/messages/{seq} —— 撤回：本人或管理员。
// 不物理删：打 Deleted 标记并清空内容，历史里显示「消息已撤回」。
func apiDeleteMessage(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	rm := roomOf(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil || seq <= 0 {
		writeErr(w, fail(400, "seq 不合法"))
		return
	}
	key := msgKey(sp.ID, rm.ID)
	for _, m := range db.Messages[key] {
		if m.Seq == seq {
			if m.UID != u.ID && !canManage(sp, u.ID) {
				writeErr(w, fail(403, "只能撤回自己的消息"))
				return
			}
			m.Deleted = true
			m.Text = ""
			m.Img = ""
			db.bump(sp.ID)
			writeJSON(w, 200, m)
			return
		}
	}
	writeErr(w, fail(404, "没有这条消息"))
}

// POST /api/spaces/{sid}/rooms/{rid}/images —— 截图上传。
// 客户端已压好（最长边 1280，JPEG q0.85），这里只验大小和类型，存 data/img/。
func apiUploadImage(w http.ResponseWriter, r *http.Request) {
	_, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if roomOf(sp, r.PathValue("rid")) == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 512*1024+1))
	if err != nil || len(b) == 0 {
		writeErr(w, fail(400, "图片内容是空的"))
		return
	}
	if len(b) > 512*1024 {
		writeErr(w, fail(413, "图片太大（上限 512KB）"))
		return
	}
	ext := ".jpg"
	switch ct := r.Header.Get("Content-Type"); {
	case strings.HasPrefix(ct, "image/png"):
		ext = ".png"
	case strings.HasPrefix(ct, "image/webp"):
		ext = ".webp"
	case strings.HasPrefix(ct, "image/jpeg"):
	default:
		writeErr(w, fail(400, "只收 jpg/png/webp"))
		return
	}
	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		writeErr(w, fail(500, "随机数失败"))
		return
	}
	name := hex.EncodeToString(id) + ext
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		writeErr(w, fail(500, "建目录失败"))
		return
	}
	if err := os.WriteFile(filepath.Join(imgDir, name), b, 0o644); err != nil {
		writeErr(w, fail(500, "写文件失败"))
		return
	}
	writeJSON(w, 200, map[string]any{"url": "/img/" + name})
}

// 截图本体目录。data/ 一定存在（fong.json 就在里面），img 放它底下好备份好清理。
var imgDir = "data/img"

// GET /img/{name} —— 消息截图本体。文件名 24 位随机 hex，不可枚举；无鉴权（URL 即凭证）。
func apiGetImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ext := filepath.Ext(name)
	hexPart := strings.TrimSuffix(name, ext)
	switch ext {
	case ".jpg", ".png", ".webp":
	default:
		http.NotFound(w, r)
		return
	}
	if len(hexPart) != 24 {
		http.NotFound(w, r)
		return
	}
	for i := 0; i < len(hexPart); i++ {
		c := hexPart[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, filepath.Join(imgDir, name))
}

// GET /api/spaces/{sid}/rooms/{rid}/messages?after=<seq>&limit=<n>
// after=0 表示要最新的一批；返回按 seq 升序。
func apiGetMessages(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	defer db.mu.Unlock()
	// needMember=true：读消息也要是成员，否则知道 sid/rid 就能扒别人的聊天记录
	_, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	rm := roomOf(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	after := int64(0)
	if v := r.URL.Query().Get("after"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			after = n
		}
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	all := db.Messages[msgKey(sp.ID, rm.ID)]
	out := make([]*Msg, 0, limit)
	if after == 0 {
		// 要最近的 limit 条
		start := 0
		if len(all) > limit {
			start = len(all) - limit
		}
		out = append(out, all[start:]...)
	} else {
		for _, m := range all {
			if m.Seq > after {
				out = append(out, m)
				if len(out) >= limit {
					break
				}
			}
		}
	}
	writeJSON(w, 200, map[string]any{"messages": out, "count": len(all)})
}

// ---------- 限流 ----------
//
// 公网暴露的接口必须有速率限制，否则：
//   - 注册接口被刷（垃圾账号 + 撑爆 users 表）
//   - 登录接口被暴力猜密码
//   - /api/find 被用来穷举房间号（32^6 = 10.7 亿，但机器能跑）
//
// 用滑动窗口计数，按 IP 分桶。IP 取 RemoteAddr —— 服务端直接对外暴露、
// 前面没有可信代理，所以不能信任 X-Forwarded-For（可伪造）。
type rateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]int64
	limit  int
	window time.Duration
	lastGC int64
}

func newLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]int64{}, limit: limit, window: window}
}

func (rl *rateLimiter) allow(key string) bool {
	now := time.Now().UnixNano()
	cutoff := now - int64(rl.window)
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// 顺手清理：每 1000 次调用扫一遍过期桶，防止 map 无限增长
	if n := len(rl.hits); n > 1000 && now-rl.lastGC > int64(time.Minute) {
		for k, v := range rl.hits {
			keep := v[:0]
			for _, t := range v {
				if t > cutoff {
					keep = append(keep, t)
				}
			}
			if len(keep) == 0 {
				delete(rl.hits, k)
			} else {
				rl.hits[k] = keep
			}
		}
		rl.lastGC = now
	}

	v := rl.hits[key]
	keep := v[:0]
	for _, t := range v {
		if t > cutoff {
			keep = append(keep, t)
		}
	}
	if len(keep) >= rl.limit {
		rl.hits[key] = keep
		return false
	}
	rl.hits[key] = append(keep, now)
	return true
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return host
}

// 限流表。注册最严（要发邮件/建记录），find 次之（防枚举），其余宽松。
var (
	rlRegister  = newLimiter(5, 10*time.Minute) // 每 IP 10 分钟 5 次
	rlLogin     = newLimiter(10, 5*time.Minute) // 每 IP 5 分钟 10 次
	rlFind      = newLimiter(40, time.Minute)   // 每 IP 每分钟 40 次，防房间号枚举
	rlRegister0 = newLimiter(20, time.Minute)   // 匿名注册
	rlAvatar    = newLimiter(30, time.Minute)   // 头像/昵称修改（防刷）
	rlDownload  = newLimiter(60, time.Minute)   // 下载：正常用户最多几次
	rlReleases  = newLimiter(30, time.Minute)   // 版本查询
	rlMsg       = newLimiter(120, time.Minute)  // 发消息：够正常聊天，挡刷屏
	rlMsgGet    = newLimiter(240, time.Minute)  // 拉消息：客户端轮询用
)

func throttle(l *rateLimiter, w http.ResponseWriter, r *http.Request, what string) bool {
	if l.allow(clientIP(r)) {
		return false
	}
	w.Header().Set("Retry-After", "60")
	msg := "操作太频繁，稍后再试"
	if what != "" {
		msg = "操作太频繁，稍后再试（" + what + "）"
	}
	writeErr(w, fail(429, msg))
	return true
}

// GET / —— 落地页。没配 -web 就给个纯文本提示，别返回 404 让人以为服务挂了。
func apiLanding(w http.ResponseWriter, r *http.Request) {
	if webDir == "" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("FONG 服务正常。客户端下载见 /dl/"))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
}

// apiPage 返回一个只服务 webDir 下指定文件的 handler（法务页 / robots.txt）。
// 文件不存在时给 404 纯文本，别把 JSON 错误页吐给浏览器。
func apiPage(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if webDir == "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		p := filepath.Join(webDir, name)
		if _, err := os.Stat(p); err != nil {
			http.Error(w, "页面还没上线", http.StatusNotFound)
			return
		}
		if strings.HasSuffix(name, ".html") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		}
		http.ServeFile(w, r, p)
	}
}

// GET /dl/{name} —— 安装包下载。
// 只允许 dlDir 下的单层文件名：拒绝任何路径分隔符和 ..
// （http.ServeFile 自己会处理 Range，断点续传可用）
func apiDownload(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") ||
		strings.HasPrefix(name, ".") {
		writeErr(w, fail(404, "文件不存在"))
		return
	}
	if dlDir == "" {
		writeErr(w, fail(404, "本服务器未开放下载"))
		return
	}
	p := filepath.Join(dlDir, name)
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() {
		writeErr(w, fail(404, "文件不存在"))
		return
	}
	// 统计只记真实存在的文件下载（放在 stat 之后，避免把 404 也算进去）
	bumpDownload()
	// 大文件下载可能很慢，别让反向代理或浏览器瞎猜
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

// GET /api/releases —— 版本清单，客户端用来检查更新。
// 读 dlDir/releases.json，没有就返回空列表（不报错，老客户端也能调）。
func apiReleases(w http.ResponseWriter, r *http.Request) {
	if dlDir == "" {
		writeJSON(w, 200, map[string]any{"latest": "", "releases": []any{}})
		return
	}
	b, err := os.ReadFile(filepath.Join(dlDir, "releases.json"))
	if err != nil {
		writeJSON(w, 200, map[string]any{"latest": "", "releases": []any{}})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(b)
}

func withLimit(l *rateLimiter, name string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if throttle(l, w, r, name) {
			return
		}
		h(w, r)
	}
}

func registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/register", withLimit(rlRegister0, "注册", apiRegister))
	// 邮箱账号
	mux.HandleFunc("POST /api/auth/register", withLimit(rlRegister, "注册", apiAuthRegister))
	mux.HandleFunc("POST /api/auth/login", withLimit(rlLogin, "登录", apiAuthLogin))
	mux.HandleFunc("POST /api/auth/bind", withLimit(rlLogin, "绑定", apiAuthBind))
	mux.HandleFunc("GET /api/auth/devices", apiListDevices)
	mux.HandleFunc("POST /api/auth/devices/remove", apiRemoveDevice)
	codeH := newCodeHandler()
	mux.HandleFunc("POST /api/auth/code/send", withLimit(rlLogin, "发验证码", codeH.Send))
	mux.HandleFunc("POST /api/auth/code/login", withLimit(rlLogin, "验证码登录", codeH.Login))
	// 前端据此决定要不要显示「验证码」页签（没配发信通道就别让用户白点）
	mux.HandleFunc("GET /api/auth/code/available", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"available": codeMailReady})
	})
	mux.HandleFunc("GET /api/auth/me", apiAuthMe)
	mux.HandleFunc("PATCH /api/me/avatar", withLimit(rlAvatar, "改头像", apiSetAvatar))
	mux.HandleFunc("PATCH /api/me/name", withLimit(rlAvatar, "改昵称", apiSetName))
	// 用房间号找空间
	mux.HandleFunc("GET /api/find/{code}", withLimit(rlFind, "查找房间", apiFindByCode))
	// 客户端安装包下载（大文件，限流放到很宽，只挡滥用）
	mux.HandleFunc("GET /dl/{name}", withLimit(rlDownload, "下载", apiDownload))
	mux.HandleFunc("GET /api/releases", withLimit(rlReleases, "版本查询", apiReleases))
	// 落地页（{$} 是 Go 1.22 的精确匹配，只命中根路径，不吞 /api/* 和 /dl/*）
	mux.HandleFunc("GET /{$}", apiLanding)
	// 法务页：客户端「用户协议 / 隐私政策」链接指向 /terms 与 /privacy
	mux.HandleFunc("GET /terms", apiPage("terms.html"))
	mux.HandleFunc("GET /privacy", apiPage("privacy.html"))
	mux.HandleFunc("GET /robots.txt", apiPage("robots.txt"))
	mux.HandleFunc("POST /api/spaces", apiCreateSpace)
	mux.HandleFunc("GET /api/spaces/{sid}", apiGetSpace)
	mux.HandleFunc("PATCH /api/spaces/{sid}", apiPatchSpace)
	mux.HandleFunc("DELETE /api/spaces/{sid}", apiDeleteSpace)
	mux.HandleFunc("POST /api/spaces/{sid}/join", apiJoinSpace)
	mux.HandleFunc("POST /api/spaces/{sid}/leave", apiLeaveSpace)
	mux.HandleFunc("POST /api/spaces/{sid}/rooms", apiCreateRoom)
	mux.HandleFunc("PATCH /api/spaces/{sid}/rooms/{rid}", apiPatchRoom)
	mux.HandleFunc("DELETE /api/spaces/{sid}/rooms/{rid}", apiDeleteRoom)
	mux.HandleFunc("PATCH /api/spaces/{sid}/members/{uid}", apiPatchMember)
	mux.HandleFunc("DELETE /api/spaces/{sid}/members/{uid}", apiKick)
	// 【0.4.66】封禁 / 解封（空间级）
	// 【0.4.67】频道密码
	mux.HandleFunc("PATCH /api/spaces/{sid}/rooms/{rid}/password", withLimit(rlBan, "改频道密码", apiSetRoomPassword))
	mux.HandleFunc("POST /api/spaces/{sid}/rooms/{rid}/password/check", withLimit(rlBan, "校验频道密码", apiCheckRoomPassword))
	mux.HandleFunc("POST /api/spaces/{sid}/members/{uid}/ban", withLimit(rlBan, "封禁成员", apiBanMember))
	mux.HandleFunc("DELETE /api/spaces/{sid}/members/{uid}/ban", withLimit(rlBan, "解封成员", apiUnbanMember))
	// 频道级批量静音（创建者/管理员）：一次事务，失败不留半静音状态
	mux.HandleFunc("POST /api/spaces/{sid}/mute-all", apiMuteAll)
	// 频道内置聊天（语音房也能发文字/截图）
	mux.HandleFunc("POST /api/spaces/{sid}/rooms/{rid}/messages", withLimit(rlMsg, "发消息", apiSendMessage))
	mux.HandleFunc("GET /api/spaces/{sid}/rooms/{rid}/messages", withLimit(rlMsgGet, "拉消息", apiGetMessages))
	mux.HandleFunc("DELETE /api/spaces/{sid}/rooms/{rid}/messages/{seq}", withLimit(rlMsg, "撤回消息", apiDeleteMessage))
	// 【0.4.38】编辑自己的消息 + 本空间消息搜索
	mux.HandleFunc("PATCH /api/spaces/{sid}/rooms/{rid}/messages/{seq}", withLimit(rlMsg, "编辑消息", apiEditMessage))
	mux.HandleFunc("GET /api/spaces/{sid}/search", withLimit(rlMsgGet, "搜索消息", apiSearchMessages))
	mux.HandleFunc("POST /api/spaces/{sid}/rooms/{rid}/images", withLimit(rlImg, "发截图", apiUploadImage))
	mux.HandleFunc("GET /img/{name}", apiGetImage)
	// 【0.4.49】通用文件 + 表情回应
	mux.HandleFunc("POST /api/spaces/{sid}/rooms/{rid}/files", withLimit(rlFile, "发文件", apiUploadFile))
	mux.HandleFunc("GET /file/{name}", apiGetFile)
	mux.HandleFunc("POST /api/spaces/{sid}/rooms/{rid}/messages/{seq}/reactions", withLimit(rlMsg, "回应表情", apiReactMessage))
	// 运维后台（只读监控）。未设置 FONG_ADMIN_TOKEN 时页面会提示如何开启。
	mux.HandleFunc("GET /admin", apiAdminPage)
	mux.HandleFunc("GET /api/admin/stats", apiAdminStats)

	mux.HandleFunc("POST /api/presence", apiPresence)
	mux.HandleFunc("POST /api/leave", apiLeaveRoom)
}

func apiRegister(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID, Key, Name string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	name, err := cleanName(req.Name, 16)
	if err != nil || len(req.ID) < 16 || len(req.ID) > 64 || len(req.Key) < 32 || strings.ContainsAny(req.ID, ".:") {
		writeErr(w, fail(400, "注册信息不合法"))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u := db.Users[req.ID]
	if u == nil {
		u = &User{ID: req.ID, KeyHash: hashKey(req.Key)}
		db.Users[req.ID] = u
	} else if _, v, _ := devStore.ByKey(u.ID, req.Key); !v.OK {
		// 被 FIFO 淘汰 / 被移除 / 改密作废的 key，不能靠重启又登记回来
		writeErr(w, unauth(reasonText(v.Reason), v.Reason))
		return
	}
	if u.Name != name {
		u.Name = name
		for sid, sp := range db.Spaces {
			if sp.Members[u.ID] != nil {
				db.bump(sid)
			}
		}
	}
	db.dirty = true
	if err := bindDevice(r, u.ID, req.Key); err != nil {
		writeErr(w, fail(500, "注册失败，请稍后再试"))
		return
	}
	writeJSON(w, 200, map[string]string{"id": u.ID, "name": u.Name})
}

// 带鉴权 + 取空间的通用前置
// 【0.4.67 · 测试环境互锁】
// 起因：e2e 回归脚本把服务器地址写死成生产地址，跑了十几次回归后
// 生产库里多了 277 个测试空间 / 593 个测试用户 —— 而后续的产品规模判断
// （"最大 4 人所以不做成员搜索"）就是拿这堆污染数据做的。
//
// 上一级防线是"测试入口断言目标是本地"，但那只管现有的文件；
// 新写的脚本、手动跑的野命令照样能写进来。这一级是物理隔离：
//
// 请求带 X-Fong-Test 头 = 测试流量 → 生产服务端直接 403。
// 本地测试服务用 -allow-test 启动才放行。
//
// 即使某个测试把地址写错了、即使有人手滑 curl 到线上，也写不进生产库。
var allowTestTraffic = false // 由 -allow-test flag 置位

func rejectTestTraffic(w http.ResponseWriter, r *http.Request) bool {
	if allowTestTraffic {
		return false
	}
	if r.Header.Get("X-Fong-Test") == "" {
		return false
	}
	writeErr(w, failR(403, "这是生产服务，不接受测试流量。测试请指向本地服务。", "PROD_REJECTS_TEST"))
	return true
}

// 【0.4.66】空间访问模式。三态而不是原来的 needMember bool。
//
// 为什么要三态：封禁校验必须覆盖全部 19 个调用点（18 个传 true + apiJoinSpace 传 false），
// 逐个端点改会漏；统一在这里拦最可靠。而 apiGetSpace 必须例外放行 ——
// 被封禁者要能读到"我被封了"这个状态，否则前端只能一直转圈。
type spaceAccess int

const (
	accessPublic         spaceAccess = iota // 不要求成员（apiJoinSpace）
	accessMember                            // 要求成员且未封禁（18 处默认）
	accessMemberOrBanned                    // 成员或封禁者都放行（仅 apiGetSpace）
)

func withSpace(w http.ResponseWriter, r *http.Request, mode spaceAccess) (*User, *SpaceRec, bool) {
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return nil, nil, false
	}
	sp := db.Spaces[r.PathValue("sid")]
	if sp == nil {
		writeErr(w, fail(404, "空间不存在或已解散"))
		return nil, nil, false
	}
	if ok, reason, msg := spaceAccessCheck(sp, u.ID, mode); !ok {
		writeErr(w, failR(403, msg, reason))
		return nil, nil, false
	}
	return u, sp, true
}

// spaceAccessCheck 是 withSpace 的判定核心，独立出来便于穷举测试。
// 返回 (放行, reason 码, 人话文案)。
//
// 注意：必须显式表达「成员 或 被封禁」，不能靠枚举值大小比较 ——
// accessMemberOrBanned > accessMember 会让"已离开的封禁用户"先拿到 NOT_MEMBER，
// 永远走不到 BANNED 判断，例外端点就白设了。
func spaceAccessCheck(sp *SpaceRec, uid string, mode spaceAccess) (bool, string, string) {
	isMember := roleOf(sp, uid) != ""
	isBanned := sp.Banned != nil && sp.Banned[uid] != nil
	switch mode {
	case accessMemberOrBanned:
		if !isMember && !isBanned {
			return false, "NOT_MEMBER", "你已不在这个空间里"
		}
		return true, "", ""
	case accessMember:
		// 【先查封禁】封禁是更强的状态：一个人既被封禁又被踢过（历史数据），
		// 报 BANNED 比报 NOT_MEMBER 更准确 —— 前者说明"是有原因的"，后者只是"不在里面"。
		// 实测：初版先查 isMember，导致这种组合报 NOT_MEMBER，用户和管理员都会困惑。
		if isBanned {
			return false, "BANNED", "你已被封禁，无法访问这个空间"
		}
		if !isMember {
			return false, "NOT_MEMBER", "你已不在这个空间里"
		}
		return true, "", ""
	case accessPublic:
		// join 也要拦：被封禁的人不能重新加入
		if isBanned {
			return false, "BANNED", "你已被封禁，无法访问这个空间"
		}
		return true, "", ""
	}
	return false, "INTERNAL", "未知访问模式"
}

// ---------- 邮箱账号 ----------

type authReq struct {
	Email string `json:"email"`
	Pass  string `json:"pass"`
	Name  string `json:"name"`
}

// POST /api/auth/register  {email, pass, name} -> {id, name, key, email}
func apiAuthRegister(w http.ResponseWriter, r *http.Request) {
	var req authReq
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	email, err := normEmail(req.Email)
	if err != nil {
		writeErr(w, err)
		return
	}
	if len(req.Pass) < 6 || len(req.Pass) > 128 {
		writeErr(w, fail(400, "密码至少 6 位"))
		return
	}
	name, err := cleanName(req.Name, 16)
	if err != nil {
		writeErr(w, err)
		return
	}

	db.mu.Lock()
	defer db.mu.Unlock()
	if _, exists := db.Emails[email]; exists {
		writeErr(w, fail(409, "这个邮箱已经注册过了"))
		return
	}
	uid := newID(16)
	key := issueKey()
	now := time.Now().UnixMilli()
	u := &User{ID: uid, Name: name, KeyHash: hashKey(key), Email: email,
		PassHash: hashPassword(req.Pass), CreatedAt: now}
	db.Users[uid] = u
	db.Emails[email] = uid
	db.dirty = true
	if err := bindDevice(r, uid, key); err != nil {
		writeErr(w, fail(500, "注册失败，请稍后再试"))
		return
	}
	log.Printf("[auth] 注册 %s (%s)", email, uid[:8])
	writeJSON(w, 200, map[string]any{"id": uid, "name": name, "key": key, "email": email})
}

// POST /api/auth/login  {email, pass} -> {id, name, key, email}
// 登录成功换发新 key（服务端只存 hash，无法反推旧 key），旧设备需重新登录。
func apiAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req authReq
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	email, err := normEmail(req.Email)
	if err != nil {
		writeErr(w, err)
		return
	}

	db.mu.Lock()
	defer db.mu.Unlock()
	uid := db.Emails[email]
	u := db.Users[uid]
	if u == nil || u.PassHash == "" {
		// 不区分「邮箱不存在」和「密码错」，避免枚举邮箱
		time.Sleep(120 * time.Millisecond)
		writeErr(w, fail(401, "邮箱或密码不对"))
		return
	}
	if !verifyPassword(req.Pass, u.PassHash) {
		time.Sleep(120 * time.Millisecond)
		writeErr(w, fail(401, "邮箱或密码不对"))
		return
	}
	// 追加设备 key 而不是替换主 key —— 手机登录不该把电脑踢下线。
	// 落库统一走 auth.BindRequest（FIFO + 墓碑都在那里做）。
	key := issueKey()
	if err := bindDevice(r, u.ID, key); err != nil {
		writeErr(w, fail(500, "登录失败，请稍后再试"))
		return
	}
	db.dirty = true
	log.Printf("[auth] 登录 %s (%s) 设备数 %d", email, uid[:8], len(u.Devices))
	writeJSON(w, 200, map[string]any{"id": u.ID, "name": u.Name, "key": key, "email": email})
}

// POST /api/auth/bind  {email, pass} -> 把一个匿名账号绑定到邮箱
// 头部带当前 X-Fong-Uid / X-Fong-Key，成功后账号可跨设备登录。
func apiAuthBind(w http.ResponseWriter, r *http.Request) {
	var req authReq
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	email, err := normEmail(req.Email)
	if err != nil {
		writeErr(w, err)
		return
	}
	if len(req.Pass) < 6 || len(req.Pass) > 128 {
		writeErr(w, fail(400, "密码至少 6 位"))
		return
	}

	db.mu.Lock()
	defer db.mu.Unlock()
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if other, exists := db.Emails[email]; exists && other != u.ID {
		writeErr(w, fail(409, "这个邮箱已经绑到别的账号了"))
		return
	}
	if u.Email != "" && u.Email != email {
		delete(db.Emails, u.Email)
	}
	u.Email = email
	u.PassHash = hashPassword(req.Pass)
	db.Emails[email] = u.ID
	db.dirty = true
	log.Printf("[auth] 绑定 %s -> %s", email, u.ID[:8])
	writeJSON(w, 200, map[string]any{"ok": true, "email": email})
}

// GET /api/auth/me -> 当前账号
func apiAuthMe(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	res := map[string]any{"id": u.ID, "name": u.Name, "email": u.Email,
		"hasPassword": u.PassHash != "", "avatar": u.Avatar}
	if u.CreatedAt > 0 {
		res["createdAt"] = u.CreatedAt
	}
	writeJSON(w, 200, res)
}

// GET /api/find/{code} -> 用 6 位房间号换 spaceId
// 不需要认证：输入房间号的人还没加入任何空间。
func apiFindByCode(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	if len(code) != 6 {
		writeErr(w, fail(400, "房间号是 6 位"))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, sp := range db.Spaces {
		if sp.JoinCode != "" && strings.EqualFold(sp.JoinCode, code) {
			writeJSON(w, 200, map[string]any{
				"spaceId": sp.ID, "name": sp.Name,
				"members": len(sp.Members), "maxUsers": sp.MaxUsers,
				"rooms": len(sp.Rooms),
			})
			return
		}
	}
	writeErr(w, fail(404, "没有这个房间号"))
}

func apiCreateSpace(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name, Icon string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	name, err := cleanName(req.Name, 24)
	if err != nil {
		writeErr(w, fail(400, err.Error()))
		return
	}
	if len(req.Icon) > 64<<10 {
		writeErr(w, fail(400, "图标太大"))
		return
	}
	now := time.Now().UnixMilli()
	sp := &SpaceRec{ID: newID(6), JoinCode: uniqueJoinCode(), Name: name, Icon: req.Icon,
		OwnerID: u.ID, CreatedAt: now, MaxUsers: 8,
		Members: map[string]*SpaceMember{u.ID: {Role: RoleOwner, JoinedAt: now}}, MutedByRoom: map[string]map[string]bool{}}
	sp.Rooms = []*RoomRec{{ID: newID(4), Name: "大厅", MaxUsers: 8, Order: now}}
	db.Spaces[sp.ID] = sp
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

func apiGetSpace(w http.ResponseWriter, r *http.Request) {
	// 长轮询：?since=<version> 时，版本没变就最多挂 25 秒
	since := r.URL.Query().Get("since")
	for attempt := 0; attempt < 2; attempt++ {
		db.mu.Lock()
		// 【0.4.66】唯一例外：被封禁者也要能读到"我被封了"这个状态，
		// 否则前端只能一直转圈，不会显示提示。view() 对非成员是安全的
		// （sp.Members[me] 取不到就是 nil，MyRole 返回 ""），不会 panic。
		u, sp, ok := withSpace(w, r, accessMemberOrBanned)
		if !ok {
			db.mu.Unlock()
			return
		}
		cur := db.version[sp.ID]
		if since == "" || since != fmt.Sprint(cur) || attempt == 1 {
			v := db.view(sp, u.ID)
			db.mu.Unlock()
			writeJSON(w, 200, v)
			return
		}
		c := make(chan struct{})
		db.waiters[sp.ID] = append(db.waiters[sp.ID], c)
		db.mu.Unlock()
		select {
		case <-c:
		case <-time.After(25 * time.Second):
		case <-r.Context().Done():
			return
		}
	}
}

func apiPatchSpace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     *string
		Icon     *string
		MaxUsers *int
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if !canManage(sp, u.ID) {
		writeErr(w, fail(403, "只有所有者和管理员能改空间"))
		return
	}
	if req.Name != nil {
		n, err := cleanName(*req.Name, 24)
		if err != nil {
			writeErr(w, fail(400, err.Error()))
			return
		}
		sp.Name = n
	}
	if req.Icon != nil {
		if len(*req.Icon) > 64<<10 {
			writeErr(w, fail(400, "图标太大"))
			return
		}
		sp.Icon = *req.Icon
	}
	if req.MaxUsers != nil {
		if *req.MaxUsers < 2 || *req.MaxUsers > 12 {
			writeErr(w, fail(400, "人数上限 2-12"))
			return
		}
		sp.MaxUsers = *req.MaxUsers
	}
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

func apiDeleteSpace(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	if roleOf(sp, u.ID) != RoleOwner {
		db.mu.Unlock()
		writeErr(w, fail(403, "只有所有者能解散空间"))
		return
	}
	delete(db.Spaces, sp.ID)
	db.bump(sp.ID)
	keys := []string{}
	for _, rm := range sp.Rooms {
		keys = append(keys, sp.ID+":"+rm.ID)
	}
	db.mu.Unlock()
	for _, k := range keys {
		kickRoom(k, "")
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func apiJoinSpace(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessPublic)
	if !ok {
		return
	}
	if sp.Members[u.ID] == nil {
		sp.Members[u.ID] = &SpaceMember{Role: RoleMember, JoinedAt: time.Now().UnixMilli()}
		db.bump(sp.ID)
	}
	writeJSON(w, 200, db.view(sp, u.ID))
}

func apiLeaveSpace(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	if roleOf(sp, u.ID) == RoleOwner {
		db.mu.Unlock()
		writeErr(w, fail(400, "所有者要先转让所有权，或解散空间"))
		return
	}
	delete(sp.Members, u.ID)
	db.bump(sp.ID)
	sid := sp.ID
	db.mu.Unlock()
	kickUserInSpace(sid, u.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func apiCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string
		Kind string // voice（默认）| text
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if !canManage(sp, u.ID) {
		writeErr(w, fail(403, "只有所有者和管理员能建房间"))
		return
	}
	name, err := cleanName(req.Name, 24)
	if err != nil {
		writeErr(w, fail(400, err.Error()))
		return
	}
	if len(sp.Rooms) >= 100 {
		writeErr(w, fail(400, "房间太多了"))
		return
	}
	// 命名冲突自动加序号：开黑一队 2
	taken := map[string]bool{}
	for _, x := range sp.Rooms {
		taken[x.Name] = true
	}
	final := name
	for i := 2; taken[final]; i++ {
		final = fmt.Sprintf("%s %d", name, i)
	}
	kind := "voice"
	if req.Kind == "text" {
		kind = "text"
	}
	rm := &RoomRec{ID: newID(4), Name: final, Kind: kind, MaxUsers: sp.MaxUsers, Order: time.Now().UnixMilli()}
	sp.Rooms = append(sp.Rooms, rm)
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

func findRoom(sp *SpaceRec, rid string) (int, *RoomRec) {
	for i, x := range sp.Rooms {
		if x.ID == rid {
			return i, x
		}
	}
	return -1, nil
}

func apiPatchRoom(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     *string
		Pinned   *bool
		MaxUsers *int
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if !canManage(sp, u.ID) {
		writeErr(w, fail(403, "只有所有者和管理员能改房间"))
		return
	}
	_, rm := findRoom(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "房间不存在"))
		return
	}
	if req.Name != nil {
		n, err := cleanName(*req.Name, 24)
		if err != nil {
			writeErr(w, fail(400, err.Error()))
			return
		}
		rm.Name = n
	}
	if req.Pinned != nil {
		rm.Pinned = *req.Pinned
	}
	if req.MaxUsers != nil {
		if *req.MaxUsers < 2 || *req.MaxUsers > 12 {
			writeErr(w, fail(400, "人数上限 2-12"))
			return
		}
		rm.MaxUsers = *req.MaxUsers
	}
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

func apiDeleteRoom(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	if !canManage(sp, u.ID) {
		db.mu.Unlock()
		writeErr(w, fail(403, "只有所有者和管理员能删房间"))
		return
	}
	i, rm := findRoom(sp, r.PathValue("rid"))
	if rm == nil {
		db.mu.Unlock()
		writeErr(w, fail(404, "房间不存在"))
		return
	}
	sp.Rooms = append(sp.Rooms[:i], sp.Rooms[i+1:]...)
	db.bump(sp.ID)
	v := db.view(sp, u.ID)
	key := sp.ID + ":" + rm.ID
	db.mu.Unlock()
	kickRoom(key, "")
	writeJSON(w, 200, v)
}

// PATCH 成员：{role:"admin"|"member"|"owner"(转让)} 或 {muted:true|false}
func apiPatchMember(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Role  *Role
		Muted *bool
		// 静音是频道级的，必须指定在哪个频道静音。
		// 不传 room 时退回「该用户当前所在的频道」，保证老客户端还能用。
		Room string `json:"room"`
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	target := r.PathValue("uid")
	tm := sp.Members[target]
	if tm == nil {
		writeErr(w, fail(404, "对方不在这个空间"))
		return
	}
	me := roleOf(sp, u.ID)
	if req.Muted != nil {
		if !canManage(sp, u.ID) || tm.Role == RoleOwner || (me == RoleAdmin && tm.Role == RoleAdmin && target != u.ID) {
			writeErr(w, fail(403, "没有权限静音对方"))
			return
		}
		rid := strings.TrimSpace(req.Room)
		if rid == "" {
			rid = currentRoomOf(sp, target)
		}
		if rid == "" {
			writeErr(w, fail(400, "静音需要指定频道"))
			return
		}
		if sp.MutedByRoom[rid] == nil {
			sp.MutedByRoom[rid] = map[string]bool{}
		}
		if *req.Muted {
			sp.MutedByRoom[rid][target] = true
		} else {
			delete(sp.MutedByRoom[rid], target)
		}
	}
	if req.Role != nil {
		if me != RoleOwner || target == u.ID {
			writeErr(w, fail(403, "只有所有者能调整身份"))
			return
		}
		switch *req.Role {
		case RoleAdmin, RoleMember:
			tm.Role = *req.Role
		case RoleOwner:
			tm.Role = RoleOwner
			sp.Members[u.ID].Role = RoleAdmin
			sp.OwnerID = target
		default:
			writeErr(w, fail(400, "未知身份"))
			return
		}
	}
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

// POST /api/spaces/{sid}/mute-all  {room:"<roomKey>", muted:true|false}
//
// 频道创建者/管理员的「全频道静音」：一次事务把该频道内所有成员的服务端静音标记
// 一次性置位/清除，避免客户端循环发 N 个 PATCH（中途失败会留下半静音状态）。
//
// 语义要点：
//   - 只作用于**当前在频道里**的人，静音只在这个频道生效（频道级）
//   - 不动所有者；管理员不能批量静音另一个管理员（与单人静音的规则保持一致）
//   - 静音后仍能听（服务端只拦他们的上行转发，见 isServerMuted）
func apiMuteAll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Room  string `json:"room"`
		Muted *bool  `json:"muted"`
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.Muted == nil || strings.TrimSpace(req.Room) == "" {
		writeErr(w, fail(400, "缺少 room 或 muted 参数"))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if !canManage(sp, u.ID) {
		writeErr(w, fail(403, "没有权限静音整个频道"))
		return
	}
	// 找出这个频道里当前在线的成员
	var roomRec *RoomRec
	for _, rr := range sp.Rooms {
		if rr.ID == req.Room || rr.Name == req.Room {
			roomRec = rr
			break
		}
	}
	if roomRec == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	me := roleOf(sp, u.ID)
	n := 0
	// 在线成员来自 livePeers(spaceID:roomID)，RoomRec 里不存成员
	for _, p := range livePeers(sp.ID + ":" + roomRec.ID) {
		uid := uidOfPeer(p)
		if uid == "" || uid == u.ID || uid == sp.OwnerID {
			continue
		}
		tr := roleOf(sp, uid)
		if me == RoleAdmin && (tr == RoleAdmin || tr == RoleOwner) {
			continue // 管理员之间不能批量互静音
		}
		if sp.MutedByRoom[roomRec.ID] == nil {
			sp.MutedByRoom[roomRec.ID] = map[string]bool{}
		}
		if *req.Muted {
			sp.MutedByRoom[roomRec.ID][uid] = true
		} else {
			delete(sp.MutedByRoom[roomRec.ID], uid)
		}
		n++
	}
	db.bump(sp.ID)
	writeJSON(w, 200, map[string]any{"ok": true, "count": n, "space": db.view(sp, u.ID)})
}

// 踢人：移出空间 + 断开语音
func apiKick(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	target := r.PathValue("uid")
	tr := roleOf(sp, target)
	me := roleOf(sp, u.ID)
	if !canManage(sp, u.ID) || tr == "" || tr == RoleOwner || (me == RoleAdmin && tr == RoleAdmin) || target == u.ID {
		db.mu.Unlock()
		writeErr(w, fail(403, "没有权限踢出对方"))
		return
	}
	// 【0.4.66】被封禁的人不能被"移出房间"：delete(sp.Members) 会让他从成员列表消失，
	// 前端就再也没有解封入口了 —— 封禁生效但永远解不开，只能手改 db.json。
	// 守卫必须放在权限检查【之后】：放在前面的话，无权限的人也能靠 403/409 的差异
	// 探测"某人是否被封禁"。
	if sp.Banned != nil && sp.Banned[target] != nil {
		db.mu.Unlock()
		writeErr(w, failR(409, "该成员处于封禁状态，请先解除封禁", "BANNED_MEMBER"))
		return
	}
	delete(sp.Members, target)
	for _, m := range sp.MutedByRoom {
		delete(m, target)
	}
	db.bump(sp.ID)
	v := db.view(sp, u.ID)
	sid := sp.ID
	db.mu.Unlock()
	kickUserInSpace(sid, target)
	writeJSON(w, 200, v)
}

func apiPresence(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Room, Peer                    string
		SelfMuted, Deafened, Speaking bool
		Playing                       string
	}
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if uidOfPeer(req.Peer) != u.ID {
		writeErr(w, fail(403, "身份不匹配"))
		return
	}
	p := db.presence[req.Peer]
	if p == nil {
		p = &Presence{}
		db.presence[req.Peer] = p
	}
	changed := p.SelfMuted != req.SelfMuted || p.Deafened != req.Deafened || p.Speaking != req.Speaking || p.Playing != req.Playing
	p.SelfMuted, p.Deafened, p.Speaking, p.Playing, p.Seen = req.SelfMuted, req.Deafened, req.Speaking, req.Playing, time.Now().Unix()
	if changed {
		if sid, _, ok := strings.Cut(req.Room, ":"); ok {
			if _, ok := db.Spaces[sid]; ok {
				db.bump(sid)
			}
		}
	}
	w.WriteHeader(204)
}

// 主动离开：立刻释放，不等 ICE 超时（否则别人会看到“幽灵成员”几十秒）
func apiLeaveRoom(w http.ResponseWriter, r *http.Request) {
	var req struct{ Room, Peer string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	u, err := authUser(r)
	db.mu.Unlock()
	if err != nil {
		writeErr(w, err)
		return
	}
	if uidOfPeer(req.Peer) != u.ID {
		writeErr(w, fail(403, "身份不匹配"))
		return
	}
	roomsMu.RLock()
	rm := rooms[req.Room]
	roomsMu.RUnlock()
	if rm != nil {
		rm.mu.RLock()
		p := rm.peers[req.Peer]
		rm.mu.RUnlock()
		if p != nil {
			p.close("")
		}
	}
	w.WriteHeader(204)
}

func kickRoom(roomKey, reason string) {
	roomsMu.RLock()
	rm := rooms[roomKey]
	roomsMu.RUnlock()
	if rm == nil {
		return
	}
	rm.mu.RLock()
	ps := []*Peer{}
	for _, p := range rm.peers {
		ps = append(ps, p)
	}
	rm.mu.RUnlock()
	for _, p := range ps {
		p.close(reason)
	}
}

func kickUserInSpace(sid, uid string) {
	roomsMu.RLock()
	var ps []*Peer
	for key, rm := range rooms {
		if !strings.HasPrefix(key, sid+":") {
			continue
		}
		rm.mu.RLock()
		for id, p := range rm.peers {
			if uidOfPeer(id) == uid {
				ps = append(ps, p)
			}
		}
		rm.mu.RUnlock()
	}
	roomsMu.RUnlock()
	for _, p := range ps {
		p.close("kicked")
	}
}

// ---------- 头像 / 昵称 ----------

// 头像上限 32KB。base64 后膨胀约 1.37 倍，所以原图要压到 ~23KB 以内。
// 客户端负责缩放和压缩，服务端只做硬上限校验。
const maxAvatarBytes = 32 << 10

// PATCH /api/me/avatar {avatar:"data:image/...;base64,..."} 或 {avatar:""} 清空
func apiSetAvatar(w http.ResponseWriter, r *http.Request) {
	var req struct{ Avatar *string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.Avatar == nil {
		writeErr(w, fail(400, "缺少 avatar"))
		return
	}
	av := *req.Avatar
	if av != "" {
		if len(av) > maxAvatarBytes {
			writeErr(w, fail(400, "头像太大（压缩后请控制在 32KB 内）"))
			return
		}
		// 只接受位图 data URI，挡掉 SVG（SVG 可内嵌脚本）
		ok := strings.HasPrefix(av, "data:image/png;base64,") ||
			strings.HasPrefix(av, "data:image/jpeg;base64,") ||
			strings.HasPrefix(av, "data:image/webp;base64,")
		if !ok {
			writeErr(w, fail(400, "头像格式只支持 PNG / JPEG / WebP"))
			return
		}
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, err := authUser(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	u.Avatar = av
	db.dirty = true
	// 头像变了要让所有空间的客户端都刷新
	for sid, sp := range db.Spaces {
		if sp.Members[u.ID] != nil {
			db.bump(sid)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "avatar": u.Avatar})
}

// PATCH /api/me/name {name:"新昵称"}
func apiSetName(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	name, err := cleanName(req.Name, 16)
	if err != nil {
		writeErr(w, fail(400, err.Error()))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, err2 := authUser(r)
	if err2 != nil {
		writeErr(w, err2)
		return
	}
	if u.Name == name {
		writeJSON(w, 200, map[string]any{"ok": true, "name": name})
		return
	}
	u.Name = name
	db.dirty = true
	for sid, sp := range db.Spaces {
		if sp.Members[u.ID] != nil {
			db.bump(sid)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
}

// ===== 【0.4.49】通用文件上传 / 下载 + 表情回应 =====

var fileDir = "data/file"

// POST /api/spaces/{sid}/rooms/{rid}/files
// 请求头：X-Fong-Filename（原始文件名，URL 编码）、Content-Type（MIME）
// 体：原始字节。返回 {url, name, size, mime}
func apiUploadFile(w http.ResponseWriter, r *http.Request) {
	_, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if roomOf(sp, r.PathValue("rid")) == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	rawName, err := url.QueryUnescape(r.Header.Get("X-Fong-Filename"))
	if err != nil || strings.TrimSpace(rawName) == "" {
		rawName = "未命名文件"
	}
	// 去掉路径成分，只留最后一段（防目录穿越）；限制长度
	rawName = filepath.Base(rawName)
	if len([]rune(rawName)) > 120 {
		rawName = string([]rune(rawName)[:120])
	}
	mime := r.Header.Get("Content-Type")
	b, err := io.ReadAll(io.LimitReader(r.Body, maxFileBytes+1))
	if err != nil || len(b) == 0 {
		writeErr(w, fail(400, "文件内容是空的"))
		return
	}
	if len(b) > maxFileBytes {
		writeErr(w, fail(413, "文件太大（上限 25MB）"))
		return
	}
	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		writeErr(w, fail(500, "随机数失败"))
		return
	}
	// 扩展名只作展示提示，下载时用原始文件名；存储名一律 hex 无扩展名，避免解析风险
	name := hex.EncodeToString(id)
	if err := os.MkdirAll(fileDir, 0o755); err != nil {
		writeErr(w, fail(500, "建目录失败"))
		return
	}
	if err := os.WriteFile(filepath.Join(fileDir, name), b, 0o644); err != nil {
		writeErr(w, fail(500, "写文件失败"))
		return
	}
	writeJSON(w, 200, FileRef{URL: "/file/" + name, Name: rawName, Size: int64(len(b)), Mime: mime})
}

// GET /file/{name} —— 文件本体。24 位随机 hex，不可枚举（URL 即凭证）。
// 一律 Content-Disposition: attachment，绝不 inline —— 防 HTML/SVG 类文件在应用源里执行。
func apiGetFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if len(name) != 24 {
		http.NotFound(w, r)
		return
	}
	for _, c := range name {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			http.NotFound(w, r)
			return
		}
	}
	b, err := os.ReadFile(filepath.Join(fileDir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	dl := r.URL.Query().Get("n")
	if dl == "" {
		dl = name
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.QueryEscape(filepath.Base(dl)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write(b)
}

// POST /api/spaces/{sid}/rooms/{rid}/messages/{seq}/reactions  body {emoji}
// 同一个人对同一个 emoji 再点一次 = 取消（KOOK/OOPZ 的 toggle 行为）。
func apiReactMessage(w http.ResponseWriter, r *http.Request) {
	var req struct{ Emoji string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	emoji := strings.TrimSpace(req.Emoji)
	if emoji == "" || utf8.RuneCountInString(emoji) > 8 {
		writeErr(w, fail(400, "表情不合法"))
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	rm := roomOf(sp, r.PathValue("rid"))
	if rm == nil {
		writeErr(w, fail(404, "频道不存在"))
		return
	}
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil || seq <= 0 {
		writeErr(w, fail(400, "seq 不合法"))
		return
	}
	for _, m := range db.Messages[msgKey(sp.ID, rm.ID)] {
		if m.Seq != seq {
			continue
		}
		if m.Deleted {
			writeErr(w, fail(400, "这条已经撤回了"))
			return
		}
		if m.Reaction == nil {
			m.Reaction = map[string][]string{}
		}
		list := m.Reaction[emoji]
		found := -1
		for i, uid := range list {
			if uid == u.ID {
				found = i
				break
			}
		}
		if found >= 0 {
			list = append(list[:found], list[found+1:]...)
		} else {
			list = append(list, u.ID)
		}
		if len(list) == 0 {
			delete(m.Reaction, emoji)
		} else {
			m.Reaction[emoji] = list
		}
		db.bump(sp.ID)
		writeJSON(w, 200, m)
		return
	}
	writeErr(w, fail(404, "消息不存在"))
}

// ===== 【0.4.67】频道密码 =====

// PATCH /api/spaces/{sid}/rooms/{rid}/password
// body: {"password": "xxx"} 设为 xxx；{"password": ""} 清除密码。
// 只有频道管理者（owner/admin）能改。密码只存 hash。
func apiSetRoomPassword(w http.ResponseWriter, r *http.Request) {
	var req struct{ Password *string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.Password == nil {
		writeErr(w, fail(400, "缺少 password 字段（传空串表示清除）"))
		return
	}
	pw := strings.TrimSpace(*req.Password)
	// 房间密码不用于账号安全，不要求复杂度；但限制长度避免超长 hash 输入
	if len([]rune(pw)) > 32 {
		writeErr(w, fail(400, "密码最多 32 个字符"))
		return
	}

	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	if !canManage(sp, u.ID) {
		writeErr(w, fail(403, "只有所有者和管理员能改频道密码"))
		return
	}
	idx, room := findRoom(sp, r.PathValue("rid"))
	if idx < 0 || room == nil {
		writeErr(w, fail(404, "房间已被删除"))
		return
	}
	if pw == "" {
		room.PasswordHash = ""
	} else {
		room.PasswordHash = hashKey(pw)
	}
	db.bump(sp.ID)
	writeJSON(w, 200, db.view(sp, u.ID))
}

// POST /api/spaces/{sid}/rooms/{rid}/password/check
// body: {"password": "xxx"} —— 前端在进房前先验一次，避免进到一半被 403。
// 这不是安全边界（真正拦截在 checkJoin），只是让 UX 少一次往返。
func apiCheckRoomPassword(w http.ResponseWriter, r *http.Request) {
	var req struct{ Password string }
	if err := body(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		return
	}
	_, room := findRoom(sp, r.PathValue("rid"))
	if room == nil {
		writeErr(w, fail(404, "房间已被删除"))
		return
	}
	if err := checkRoomPassword(room, roleOf(sp, u.ID), req.Password); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ===== 【0.4.66】封禁 =====

// canBanTarget 封禁的权限判据。与 apiKick 保持一致的等级关系：
// owner 可封任何人（除自己和 owner）；admin 只能封 member。
func canBanTarget(sp *SpaceRec, meID, targetID string) error {
	// 【顺序很要紧：先判权限，再判目标】
	// 反过来会让普通成员靠错误码差异探测别人的身份：
	// 试封 owner 得到 CANNOT_BAN_OWNER、试封 admin 得到 FORBIDDEN —— 等于一个探测接口。
	// 实测踩到：初版先判 RoleOwner，普通成员封 owner 时拿到 CANNOT_BAN_OWNER。
	me := roleOf(sp, meID)
	if !canManage(sp, meID) {
		return failR(403, "只有所有者和管理员能封禁", "FORBIDDEN")
	}
	if meID == targetID {
		return failR(400, "不能封禁自己", "CANNOT_BAN_SELF")
	}
	tr := roleOf(sp, targetID)
	if tr == "" {
		return failR(404, "该用户不是这个空间的成员", "NOT_MEMBER")
	}
	if tr == RoleOwner {
		return failR(400, "不能封禁空间所有者", "CANNOT_BAN_OWNER")
	}
	if me == RoleAdmin && tr == RoleAdmin {
		return failR(403, "管理员之间不能互相封禁", "FORBIDDEN")
	}
	return nil
}

// POST /api/spaces/{sid}/members/{uid}/ban
// 幂等：重复封禁返回 200 + alreadyBanned，不报错（管理员连点两次不该失败）。
// 只写 Banned + 断连接，【不动 Members】—— 动了就没有解封入口了。
func apiBanMember(w http.ResponseWriter, r *http.Request) {
	var req struct{ Reason string }
	_ = body(r, &req) // 理由可选，解析失败不算错

	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	target := r.PathValue("uid")
	if err := canBanTarget(sp, u.ID, target); err != nil {
		db.mu.Unlock()
		writeErr(w, err)
		return
	}
	if sp.Banned == nil {
		sp.Banned = map[string]*BanRecord{}
	}
	already := sp.Banned[target] != nil
	if !already {
		reason := strings.TrimSpace(req.Reason)
		if len([]rune(reason)) > 200 {
			reason = string([]rune(reason)[:200])
		}
		sp.Banned[target] = &BanRecord{By: u.ID, At: time.Now().UnixMilli(), Reason: reason}
		db.bump(sp.ID)
	}
	v := db.view(sp, u.ID)
	sid := sp.ID
	db.mu.Unlock()
	if !already {
		kickUserInSpace(sid, target) // 立即断开，不等他自己断
	}
	writeJSON(w, 200, map[string]any{"ok": true, "alreadyBanned": already, "view": v})
}

// DELETE /api/spaces/{sid}/members/{uid}/ban
// 【只清 Banned】不碰 Members、不碰 MutedByRoom —— 解封是解封，静音是静音。
func apiUnbanMember(w http.ResponseWriter, r *http.Request) {
	db.mu.Lock()
	u, sp, ok := withSpace(w, r, accessMember)
	if !ok {
		db.mu.Unlock()
		return
	}
	target := r.PathValue("uid")
	if !canManage(sp, u.ID) {
		db.mu.Unlock()
		writeErr(w, failR(403, "只有所有者和管理员能解封", "FORBIDDEN"))
		return
	}
	was := sp.Banned != nil && sp.Banned[target] != nil
	if was {
		delete(sp.Banned, target)
		db.bump(sp.ID)
	}
	v := db.view(sp, u.ID)
	db.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "wasBanned": was, "view": v})
}
