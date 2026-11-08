package main

// 运维后台：只读监控面板。
//
// 设计取舍：
//   - 独立文件，不改动 api.go / main.go 的任何现有逻辑（降低回归风险）
//   - 用单独的 ADMIN_TOKEN 环境变量鉴权，不依赖用户体系
//     （后台不该和业务账号耦合：某个空间管理员不该看到全站数据）
//   - 只读：不提供踢人/删数据/改配置的接口，避免误操作
//   - 数据全部从内存实时算，不落盘、不加额外锁竞争

import (
	"crypto/subtle"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

func memAllocMB() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.Alloc / 1024 / 1024
}

func goroutineCount() int { return runtime.NumGoroutine() }

var (
	adminToken string
	// 峰值统计：进程启动以来的最高在线数，供面板显示历史水位
	peakMu     sync.Mutex
	peakOnline int
	peakAt     int64
	startedAt  = time.Now().Unix()
)

func initAdmin() {
	adminToken = strings.TrimSpace(os.Getenv("FONG_ADMIN_TOKEN"))
}

// adminAuth 校验 token。支持 query 参数（方便浏览器直接打开）和 Bearer 头。
func adminAuth(r *http.Request) bool {
	if adminToken == "" {
		return false
	}
	got := r.URL.Query().Get("token")
	if got == "" {
		h := r.Header.Get("Authorization")
		if strings.HasPrefix(h, "Bearer ") {
			got = strings.TrimPrefix(h, "Bearer ")
		}
	}
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(adminToken)) == 1
}

// ---------- 统计快照 ----------

type adminRoom struct {
	SpaceID   string   `json:"spaceId"`
	SpaceName string   `json:"spaceName"`
	RoomID    string   `json:"roomId"`
	RoomName  string   `json:"roomName"`
	Kind      string   `json:"kind"`
	Online    int      `json:"online"`
	Speaking  int      `json:"speaking"`
	Muted     int      `json:"muted"`
	Peers     []string `json:"peers"`
}

type adminSpace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	OwnerID   string `json:"ownerId"`
	CreatedAt int64  `json:"createdAt"`
	Members   int    `json:"members"`
	Rooms     int    `json:"rooms"`
	Messages  int    `json:"messages"`
	Online    int    `json:"online"`
}

type adminUser struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	Spaces    int    `json:"spaces"`
	Online    bool   `json:"online"`
}

type adminStats struct {
	At          int64        `json:"at"`
	StartedAt   int64        `json:"startedAt"`
	UptimeSec   int64        `json:"uptimeSec"`
	Users       int          `json:"users"`
	Emails      int          `json:"emails"`
	Spaces      int          `json:"spaces"`
	Rooms       int          `json:"rooms"`
	OnlinePeers int          `json:"onlinePeers"`
	OnlineUsers int          `json:"onlineUsers"`
	PeakOnline  int          `json:"peakOnline"`
	PeakAt      int64        `json:"peakAt"`
	Speaking    int          `json:"speaking"`
	Muted       int          `json:"muted"`
	Messages    int          `json:"messages"`
	Downloads   int64        `json:"downloads"`
	MemAllocMB  uint64       `json:"memAllocMB"`
	Goroutines  int          `json:"goroutines"`
	SpaceList   []adminSpace `json:"spaceList"`
	RoomList    []adminRoom  `json:"roomList"`
	UserList    []adminUser  `json:"userList"`
}

// 进程级下载计数（/dl/ 的 200 响应数）
var (
	dlCountMu sync.Mutex
	dlCount   int64
)

func bumpDownload() {
	dlCountMu.Lock()
	dlCount++
	dlCountMu.Unlock()
}

func downloadCount() int64 {
	dlCountMu.Lock()
	defer dlCountMu.Unlock()
	return dlCount
}

func collectStats() adminStats {
	now := time.Now()

	// 先在锁外把房间在线情况拍下来（rooms 有自己的锁，顺序要和别处一致：
	// 先 roomsMu 再 r.mu，和 livePeers 一致，避免和主路径反序死锁）
	type roomLive struct {
		key   string
		peers []string
		speak int
		mute  int
	}
	roomsMu.RLock()
	keys := make([]string, 0, len(rooms))
	for k := range rooms {
		keys = append(keys, k)
	}
	roomsMu.RUnlock()

	live := make([]roomLive, 0, len(keys))
	for _, k := range keys {
		roomsMu.RLock()
		r := rooms[k]
		roomsMu.RUnlock()
		if r == nil {
			continue
		}
		r.mu.RLock()
		peers := make([]string, 0, len(r.peers))
		for id := range r.peers {
			peers = append(peers, id)
		}
		r.mu.RUnlock()
		live = append(live, roomLive{key: k, peers: peers})
	}

	// presence 和业务数据一起在 db.mu 下读，保证一致性
	db.mu.Lock()
	defer db.mu.Unlock()

	st := adminStats{
		At:        now.Unix(),
		StartedAt: startedAt,
		UptimeSec: now.Unix() - startedAt,
		Users:     len(db.Users),
		Emails:    len(db.Emails),
		Spaces:    len(db.Spaces),
		Messages:  0,
	}
	for _, msgs := range db.Messages {
		st.Messages += len(msgs)
	}
	for _, sp := range db.Spaces {
		st.Rooms += len(sp.Rooms)
	}

	onlineUsers := map[string]bool{}

	for _, lv := range live {
		sid, rid, ok := strings.Cut(lv.key, ":")
		if !ok {
			continue
		}
		sp := db.Spaces[sid]
		if sp == nil {
			continue
		}
		ar := adminRoom{SpaceID: sid, RoomID: rid, Kind: "voice"}
		if sp != nil {
			ar.SpaceName = sp.Name
		}
		for _, rr := range sp.Rooms {
			if rr.ID == rid {
				ar.RoomName = rr.Name
				if rr.Kind != "" {
					ar.Kind = rr.Kind
				}
				break
			}
		}
		for _, p := range lv.peers {
			uid := uidOfPeer(p)
			onlineUsers[uid] = true
			ar.Peers = append(ar.Peers, p)
			if pr := db.presence[p]; pr != nil {
				if pr.Speaking {
					ar.Speaking++
					st.Speaking++
				}
				if pr.SelfMuted || pr.Deafened {
					ar.Muted++
					st.Muted++
				}
			}
		}
		ar.Online = len(lv.peers)
		if ar.Online > 0 {
			sort.Strings(ar.Peers)
			st.RoomList = append(st.RoomList, ar)
		}
	}

	st.OnlinePeers = 0
	for _, lv := range live {
		st.OnlinePeers += len(lv.peers)
	}
	st.OnlineUsers = len(onlineUsers)

	// 峰值
	peakMu.Lock()
	if st.OnlinePeers > peakOnline {
		peakOnline = st.OnlinePeers
		peakAt = now.Unix()
	}
	st.PeakOnline = peakOnline
	st.PeakAt = peakAt
	peakMu.Unlock()

	if st.RoomList == nil {
		st.RoomList = []adminRoom{}
	}

	// 空间列表
	for _, sp := range db.Spaces {
		as := adminSpace{
			ID: sp.ID, Name: sp.Name, OwnerID: sp.OwnerID,
			CreatedAt: sp.CreatedAt, Members: len(sp.Members), Rooms: len(sp.Rooms),
		}
		for _, rr := range sp.Rooms {
			for _, lv := range live {
				if lv.key == sp.ID+":"+rr.ID {
					as.Online += len(lv.peers)
				}
			}
			as.Messages += len(db.Messages[sp.ID+":"+rr.ID])
		}
		st.SpaceList = append(st.SpaceList, as)
	}
	sort.Slice(st.SpaceList, func(i, j int) bool { return st.SpaceList[i].Online > st.SpaceList[j].Online })
	if st.SpaceList == nil {
		st.SpaceList = []adminSpace{}
	}

	// 用户列表：在线优先，其次新的在前
	spaceCount := map[string]int{}
	for _, sp := range db.Spaces {
		for uid := range sp.Members {
			spaceCount[uid]++
		}
	}
	for id, u := range db.Users {
		st.UserList = append(st.UserList, adminUser{
			ID: id, Name: u.Name, Email: u.Email, CreatedAt: u.CreatedAt,
			Spaces: spaceCount[id], Online: onlineUsers[id],
		})
	}
	sort.Slice(st.UserList, func(i, j int) bool {
		if st.UserList[i].Online != st.UserList[j].Online {
			return st.UserList[i].Online
		}
		return st.UserList[i].CreatedAt > st.UserList[j].CreatedAt
	})
	if st.UserList == nil {
		st.UserList = []adminUser{}
	}

	st.Downloads = downloadCount()
	st.MemAllocMB = memAllocMB()
	st.Goroutines = goroutineCount()
	return st
}

// GET /api/admin/stats
func apiAdminStats(w http.ResponseWriter, r *http.Request) {
	if !adminAuth(r) {
		writeErr(w, fail(401, "未授权"))
		return
	}
	writeJSON(w, 200, collectStats())
}

// GET /admin  —— 单页面板，数据靠上面的接口轮询
func apiAdminPage(w http.ResponseWriter, r *http.Request) {
	if adminToken == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte("<!doctype html><meta charset=utf-8><body style=\"font:15px/1.7 system-ui;padding:40px;background:#111;color:#eee\">" +
			"<h2>后台未启用</h2><p>需要在服务端设置环境变量 <code>FONG_ADMIN_TOKEN</code> 后重启：</p>" +
			"<pre style=\"background:#000;padding:12px;border-radius:6px\">" +
			"echo 'FONG_ADMIN_TOKEN=你的口令' &gt;&gt; /etc/fong/admin.env\n" +
			"systemctl restart fong-sfu</pre></body>"))
		return
	}
	if !adminAuth(r) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(401)
		w.Write([]byte(nil))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(adminHTML))
}

const adminHTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FONG 后台</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#0b0c0e;color:#e8eaed}
header{padding:16px 22px;border-bottom:1px solid #1e2126;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.3px}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;background:#1a2e1a;color:#6ee06e;border:1px solid #245224}
.badge.off{background:#2e1a1a;color:#e06e6e;border-color:#522424}
.wrap{padding:18px 22px;max-width:1500px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:#121417;border:1px solid #1e2126;border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:#8b929c;margin-bottom:6px}
.card .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15}
.card .s{font-size:11px;color:#666d78;margin-top:4px}
h2{font-size:13px;color:#8b929c;font-weight:600;margin:22px 0 10px;text-transform:uppercase;letter-spacing:.6px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:#8b929c;font-size:12px;padding:8px 10px;border-bottom:1px solid #1e2126;white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid #16191d;vertical-align:middle}
tr:hover td{background:#111316}
.dim{color:#666d78}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3a3f47;margin-right:6px}
.dot.on{background:#4ade80;box-shadow:0 0 6px #4ade8088}
.dot.sp{background:#facc15;box-shadow:0 0 8px #facc15aa}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9aa1ab}
.empty{color:#666d78;padding:16px 10px;font-style:italic}
.err{background:#2e1a1a;border:1px solid #522424;color:#ffb4b4;padding:10px 14px;border-radius:8px;margin-bottom:14px;display:none}
</style></head><body>
<header>
  <h1>FONG 后台</h1>
  <span class="badge" id="hb">连接中…</span>
  <span class="dim" id="up" style="font-size:12px"></span>
  <span style="flex:1"></span>
  <span class="dim" id="ts" style="font-size:12px"></span>
</header>
<div class="wrap">
  <div class="err" id="err"></div>
  <div class="cards" id="cards"></div>

  <h2>在线房间</h2>
  <table><thead><tr>
    <th>空间</th><th>房间</th><th>类型</th><th>在线</th><th>说话</th><th>静音</th><th>成员</th>
  </tr></thead><tbody id="rooms"></tbody></table>

  <h2>空间</h2>
  <table><thead><tr>
    <th>名称</th><th>ID</th><th>成员</th><th>频道</th><th>消息</th><th>在线</th><th>创建</th>
  </tr></thead><tbody id="spaces"></tbody></table>

  <h2>用户</h2>
  <table><thead><tr>
    <th>昵称</th><th>ID</th><th>邮箱</th><th>空间数</th><th>状态</th><th>注册</th>
  </tr></thead><tbody id="users"></tbody></table>
</div>
<script>
'use strict';
const q = new URLSearchParams(location.search);
const TOKEN = q.get('token') || '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtTime = (s) => { if (!s) return '—'; const d = new Date(s * 1000); 
  return d.toLocaleString('zh-CN', {hour12:false}).replace(/\//g,'-'); };
const fmtDur = (s) => { if (s < 60) return s + ' 秒'; if (s < 3600) return Math.floor(s/60) + ' 分钟';
  if (s < 86400) return Math.floor(s/3600) + ' 小时 ' + Math.floor(s%3600/60) + ' 分';
  return Math.floor(s/86400) + ' 天 ' + Math.floor(s%86400/3600) + ' 小时'; };

let lastOk = 0, timer = null;

function card(k, v, s) {
  return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>' +
         (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>';
}

function render(d) {
  $('cards').innerHTML = [
    card('当前在线', d.onlinePeers, d.onlineUsers + ' 个用户'),
    card('峰值在线', d.peakOnline, d.peakAt ? fmtTime(d.peakAt) : '—'),
    card('说话中', d.speaking, d.muted + ' 人静音'),
    card('注册用户', d.users, d.emails + ' 个邮箱'),
    card('空间', d.spaces, d.rooms + ' 个频道'),
    card('消息总数', d.messages, ''),
    card('下载次数', d.downloads, '安装包'),
    card('运行时长', fmtDur(d.uptimeSec), '启动于 ' + fmtTime(d.startedAt)),
    card('内存', d.memAllocMB + ' MB', d.goroutines + ' 协程'),
  ].join('');

  $('rooms').innerHTML = d.roomList.length ? d.roomList.map(r =>
    '<tr><td>' + esc(r.spaceName) + ' <span class="dim mono">' + esc(r.spaceId) + '</span></td>' +
    '<td>' + esc(r.roomName || r.roomId) + '</td>' +
    '<td class="dim">' + esc(r.kind) + '</td>' +
    '<td><b style="color:#4ade80">' + r.online + '</b></td>' +
    '<td>' + (r.speaking ? '<span class="dot sp"></span>' + r.speaking : '<span class="dim">0</span>') + '</td>' +
    '<td>' + (r.muted ? r.muted : '<span class="dim">0</span>') + '</td>' +
    '<td class="mono dim" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(r.peers.join(', ')) + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="empty">当前没有人在语音频道</td></tr>';

  $('spaces').innerHTML = d.spaceList.length ? d.spaceList.map(s =>
    '<tr><td>' + esc(s.name) + '</td><td class="mono dim">' + esc(s.id) + '</td>' +
    '<td>' + s.members + '</td><td>' + s.rooms + '</td><td>' + s.messages + '</td>' +
    '<td>' + (s.online ? '<b style="color:#4ade80">' + s.online + '</b>' : '<span class="dim">0</span>') + '</td>' +
    '<td class="dim">' + fmtTime(s.createdAt) + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="empty">还没有空间</td></tr>';

  $('users').innerHTML = d.userList.length ? d.userList.map(u =>
    '<tr><td>' + esc(u.name || '—') + '</td><td class="mono dim">' + esc(u.id) + '</td>' +
    '<td class="dim">' + esc(u.email || '—') + '</td><td>' + u.spaces + '</td>' +
    '<td>' + (u.online ? '<span class="dot on"></span>在线' : '<span class="dim">离线</span>') + '</td>' +
    '<td class="dim">' + fmtTime(u.createdAt) + '</td></tr>'
  ).join('') : '<tr><td colspan="6" class="empty">还没有用户</td></tr>';
}

async function pull() {
  try {
    const r = await fetch('/api/admin/stats?token=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
    if (r.status === 401) throw new Error('token 不正确');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    lastOk = Date.now();
    render(d);
    $('hb').textContent = '实时';
    $('hb').className = 'badge';
    $('up').textContent = '· 运行 ' + fmtDur(d.uptimeSec);
    $('ts').textContent = new Date().toLocaleTimeString('zh-CN', {hour12:false});
    $('err').style.display = 'none';
  } catch (e) {
    $('hb').textContent = '断开';
    $('hb').className = 'badge off';
    $('err').textContent = '拉取失败：' + e.message + '（正在重试）';
    $('err').style.display = 'block';
  }
}

if (!TOKEN) {
  $('err').textContent = '地址缺少 token 参数。用法：/admin?token=你的口令';
  $('err').style.display = 'block';
} else {
  pull();
  timer = setInterval(pull, 3000);   // 3 秒一刷，够看又不会压服务器
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(timer); timer = null; }
    else if (!timer) { pull(); timer = setInterval(pull, 3000); }
  });
}
</script>
</body></html>`
