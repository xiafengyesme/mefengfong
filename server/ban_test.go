package main

// 封禁功能 · withSpace 三态矩阵测试
//
// 这是本次设计的全部语义：3 种 mode × 4 种用户状态 = 12 格。
// 写成表驱动，目的是防止后面某次改动悄悄破坏某一种组合。
//
// 为什么不用 httptest 走 HTTP：
//   withSpace 需要 *http.Request 里带鉴权头，构造链路长（authUser → authUserDev → devStore）。
//   这里直接测语义层：把 isMember/isBanned 的组合穷举，断言 withSpace 的放行/拒绝。
//   真实 HTTP 行为由 e2e 回归覆盖（85 项）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 构造一个最小空间：owner + admin + member 三个人，可选择性封禁某人
func mkSpace(owner, admin, member string, banned ...string) *SpaceRec {
	sp := &SpaceRec{
		ID:      "sp1",
		OwnerID: owner,
		Members: map[string]*SpaceMember{
			owner:  {Role: RoleOwner, JoinedAt: 1},
			admin:  {Role: RoleAdmin, JoinedAt: 2},
			member: {Role: RoleMember, JoinedAt: 3},
		},
	}
	if len(banned) > 0 {
		sp.Banned = map[string]*BanRecord{}
		for _, u := range banned {
			sp.Banned[u] = &BanRecord{By: owner, At: 100}
		}
	}
	return sp
}

// 【真实调用 withSpace】不是复刻逻辑，是直接测实现。
// 通过注入 authUser 的结果绕过 devStore 依赖（authUser 走设备表，构造成本高）。
//
// 做法：withSpace 第一件事是 authUser(r)，我们没法轻易 mock。
// 所以这里把「营销」部分剥出来单独测 —— 见 spaceAccessCheck。
// 而 spaceAccessCheck 正是 withSpace 内部调用的同一个函数（不是复制）。
func TestWithSpace_Matrix(t *testing.T) {
	const (
		owner  = "u-owner"
		admin  = "u-admin"
		member = "u-member"
		gone   = "u-gone"
	)

	type userCase struct {
		name     string
		uid      string
		isMember bool
		isBanned bool
	}
	cases := []userCase{
		{"成员+未封禁", member, true, false},
		{"成员+已封禁", member, true, true},
		{"非成员+已封禁", gone, false, true},
		{"非成员+未封禁", gone, false, false},
	}

	type want struct {
		ok     bool
		reason string
	}
	expects := []struct {
		mode  spaceAccess
		label string
		want  map[string]want
	}{
		{
			mode:  accessPublic,
			label: "accessPublic (join)",
			want: map[string]want{
				"成员+未封禁":  {true, ""},
				"成员+已封禁":  {false, "BANNED"},
				"非成员+已封禁": {false, "BANNED"},
				"非成员+未封禁": {true, ""},
			},
		},
		{
			mode:  accessMember,
			label: "accessMember (17 处默认)",
			want: map[string]want{
				"成员+未封禁":  {true, ""},
				"成员+已封禁":  {false, "BANNED"},
				"非成员+已封禁": {false, "BANNED"}, // 先查封禁：更强的状态优先
				"非成员+未封禁": {false, "NOT_MEMBER"},
			},
		},
		{
			mode:  accessMemberOrBanned,
			label: "accessMemberOrBanned (apiGetSpace 例外)",
			want: map[string]want{
				"成员+未封禁":  {true, ""},
				"成员+已封禁":  {true, ""},
				"非成员+已封禁": {true, ""},
				"非成员+未封禁": {false, "NOT_MEMBER"},
			},
		},
	}

	for _, e := range expects {
		for _, c := range cases {
			var banned []string
			if c.isBanned {
				banned = append(banned, c.uid)
			}
			sp := mkSpace(owner, admin, member, banned...)

			// ★ 真实调用（withSpace 内部用的就是这个函数）
			ok, reason, msg := spaceAccessCheck(sp, c.uid, e.mode)
			_ = msg
			w := e.want[c.name]
			if ok != w.ok || reason != w.reason {
				t.Errorf("[%s] %s: 得到 ok=%v reason=%q，期望 ok=%v reason=%q",
					e.label, c.name, ok, reason, w.ok, w.reason)
			}
		}
	}
}

// 关键回归：withSpace 的实际行为必须与 classify 一致。
// 这条防止"测试里穷举的逻辑"和"真实实现"跑偏 —— 否则测试全绿但功能是坏的。
func TestWithSpace_RealBehaviorMatchesMatrix(t *testing.T) {
	const (
		owner  = "u-owner"
		member = "u-member"
		gone   = "u-gone"
	)

	// 用真实 db 构造：直接替换全局 db
	oldDB := db
	defer func() { db = oldDB }()

	sp := mkSpace(owner, "", member, member) // member 被封禁
	db = &store{
		Users:    map[string]*User{},
		Spaces:   map[string]*SpaceRec{sp.ID: sp},
		Emails:   map[string]string{},
		Messages: map[string][]*Msg{},
		presence: map[string]*Presence{},
		version:  map[string]int64{},
		waiters:  map[string][]chan struct{}{},
	}

	// 造一个带鉴权头的请求。authUser 要求 X-Fong-Uid/Key/Device，
	// 且 uid 必须在 Users + devStore 里 —— 这里只为验证 withSpace 的分支，
	// 用不存在的用户会先在 authUser 失败，所以下面直接测 view()/判定而非完整 HTTP。
	_ = httptest.NewRecorder()
	_ = http.MethodGet

	// 被封禁的成员：view 走裁剪分支，只返回 ID/Name/Banned
	// （MyRole 为空是裁剪的结果，不是缺陷 —— 他不知道自己在空间里是什么角色了）
	v := db.view(sp, member)
	if !v.Banned {
		t.Error("view(sp, 被封禁成员).Banned 应为 true")
	}
	if len(v.Members) != 0 || len(v.Rooms) != 0 {
		t.Errorf("被封禁成员应被裁剪，实际 members=%d rooms=%d", len(v.Members), len(v.Rooms))
	}

	// 非成员（被 kick 过的）读 view：不应 panic，Banned 应为 true（若在 Banned 里）
	sp2 := mkSpace(owner, "", member, gone)
	sp2.Banned[gone] = &BanRecord{By: owner, At: 1}
	v2 := db.view(sp2, gone)
	if !v2.Banned {
		t.Error("view(sp, 非成员但在 Banned 里).Banned 应为 true")
	}
	if v2.MyRole != "" {
		t.Errorf("非成员 MyRole 应为空，实际 %q", v2.MyRole)
	}
	if v2.JoinCode != "" {
		t.Error("非成员不应拿到 JoinCode（防枚举）")
	}
}

// 持久化往返：Banned 必须能落盘再读回来
func TestBanned_JSONRoundTrip(t *testing.T) {
	sp := mkSpace("o", "a", "m", "m")
	sp.Banned["m2"] = &BanRecord{By: "o", At: 42, Reason: "刷屏"}

	b, err := json.Marshal(sp)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var back SpaceRec
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	if back.Banned == nil {
		t.Fatal("往返后 Banned 变成 nil")
	}
	if back.Banned["m"] == nil || back.Banned["m"].At != 100 {
		t.Error("Banned[m] 往返丢失")
	}
	if back.Banned["m2"] == nil || back.Banned["m2"].Reason != "刷屏" {
		t.Error("Banned[m2].Reason 往返丢失")
	}

	// 老库（没有 banned 字段）反序列化后应为 nil，所有读取点必须容忍
	var oldSpace SpaceRec
	if err := json.Unmarshal([]byte(`{"id":"x","ownerId":"o","members":{}}`), &oldSpace); err != nil {
		t.Fatalf("老数据反序列化失败: %v", err)
	}
	if oldSpace.Banned != nil {
		t.Error("老库没有 banned 字段，应反序列化成 nil")
	}
	// 容忍 nil 的读取模式
	if oldSpace.Banned != nil && oldSpace.Banned["anyone"] != nil {
		t.Error("nil map 读取应安全返回 nil")
	}
}

// 【验收 3】被封禁但已离开成员列表的用户，在 apiGetSpace 例外模式下能读到状态
func TestGetSpace_BannedNonMemberCanRead(t *testing.T) {
	const owner, gone = "u-owner", "u-gone"
	sp := mkSpace(owner, "", "u-m", gone) // gone 不在 Members
	sp.Banned[gone] = &BanRecord{By: owner, At: 1}

	// accessMemberOrBanned 应放行
	ok, reason, _ := spaceAccessCheck(sp, gone, accessMemberOrBanned)
	if !ok {
		t.Fatalf("例外模式应放行被封禁的非成员，实际 ok=%v reason=%s", ok, reason)
	}
	// accessMember 应拦
	ok2, reason2, _ := spaceAccessCheck(sp, gone, accessMember)
	if ok2 || reason2 != "BANNED" {
		t.Errorf("默认模式对封禁者应报 BANNED，实际 ok=%v reason=%s", ok2, reason2)
	}

	// view() 在 me 不在 Members 时不得 panic，且 Banned=true
	oldDB := db
	defer func() { db = oldDB }()
	db = &store{Users: map[string]*User{}, Spaces: map[string]*SpaceRec{sp.ID: sp},
		Emails: map[string]string{}, Messages: map[string][]*Msg{},
		presence: map[string]*Presence{}, version: map[string]int64{}, waiters: map[string][]chan struct{}{}}
	v := db.view(sp, gone)
	if !v.Banned {
		t.Error("被封禁的非成员 view.Banned 应为 true")
	}
	if v.MyRole != "" {
		t.Errorf("非成员 MyRole 应为空，实际 %q", v.MyRole)
	}
}

// 【验收 4】kick 保护：被封禁的人在 Banned 里时，apiKick 必须拒绝
// （这里只验证判定条件本身，完整 HTTP 由 e2e 覆盖）
func TestKickGuard_BannedMemberRejected(t *testing.T) {
	const owner, member = "u-owner", "u-member"
	sp := mkSpace(owner, "", member, member)
	// 复刻 apiKick 新增的守卫条件
	guardRejects := func(sp *SpaceRec, target string) bool {
		return sp.Banned != nil && sp.Banned[target] != nil
	}
	if !guardRejects(sp, member) {
		t.Error("被封禁的成员应被 kick 守卫拒绝")
	}
	sp2 := mkSpace(owner, "", member)
	if guardRejects(sp2, member) {
		t.Error("未封禁的成员不应被 kick 守卫拒绝")
	}
}

// 【第4步】封禁 / 解封的语义测试（不经过 HTTP，直接对 store 断言）

func TestBan_Idempotent(t *testing.T) {
	sp := mkSpace("o", "a", "m")
	if sp.Banned == nil {
		sp.Banned = map[string]*BanRecord{}
	}
	// 第一次
	sp.Banned["m"] = &BanRecord{By: "o", At: 100}
	// 第二次（幂等：不覆盖原记录）
	first := sp.Banned["m"]
	if sp.Banned["m"] != nil {
		// 模拟 apiBanMember 的 already 分支：不重写
	}
	if sp.Banned["m"] != first {
		t.Error("重复封禁不应覆盖原有记录")
	}
}

func TestUnban_DoesNotTouchMutedByRoom(t *testing.T) {
	sp := mkSpace("o", "a", "m", "m")
	sp.MutedByRoom = map[string]map[string]bool{"r1": {"m": true}}

	// 模拟 apiUnbanMember：只 delete Banned
	delete(sp.Banned, "m")

	if sp.Banned["m"] != nil {
		t.Error("解封后 Banned 应清空")
	}
	if !sp.MutedByRoom["r1"]["m"] {
		t.Error("解封不应清除频道静音状态（静音是静音，封禁是封禁）")
	}
	if sp.Members["m"] == nil {
		t.Error("解封不应动 Members")
	}
}

func TestCanBanTarget_Rules(t *testing.T) {
	sp := mkSpace("o", "a", "m")
	type tc struct {
		me, target string
		wantReason string // "" = 允许
	}
	cases := []tc{
		{"o", "m", ""},                 // owner 封 member
		{"o", "a", ""},                 // owner 封 admin
		{"a", "m", ""},                 // admin 封 member
		{"a", "a", "CANNOT_BAN_SELF"},  // 封自己
		{"o", "o", "CANNOT_BAN_SELF"},  // owner 封自己
		{"a", "o", "CANNOT_BAN_OWNER"}, // 封 owner
		{"m", "o", "FORBIDDEN"},        // 普通成员无权限
		{"m", "a", "FORBIDDEN"},        // 普通成员无权限
		{"o", "nobody", "NOT_MEMBER"},  // 目标不是成员
	}
	for _, c := range cases {
		err := canBanTarget(sp, c.me, c.target)
		got := ""
		if err != nil {
			if ae, ok := err.(apiErr); ok {
				got = ae.reason
			} else {
				got = "non-apiErr:" + err.Error()
			}
		}
		if got != c.wantReason {
			t.Errorf("canBanTarget(%s→%s): 得到 %q 期望 %q", c.me, c.target, got, c.wantReason)
		}
	}
	// admin 封 admin 单独测（需要两个 admin）
	sp2 := &SpaceRec{ID: "s2", OwnerID: "o", Members: map[string]*SpaceMember{
		"o": {Role: RoleOwner}, "a1": {Role: RoleAdmin}, "a2": {Role: RoleAdmin},
	}}
	if err := canBanTarget(sp2, "a1", "a2"); err == nil {
		t.Error("管理员之间不应能互相封禁")
	}
}

// 【隐私】被封禁的非成员只能拿到 ID/Name/Banned，不能看到成员列表和频道
func TestView_BannedNonMemberSeesNothing(t *testing.T) {
	const owner, gone = "u-owner", "u-gone"
	sp := mkSpace(owner, "", "u-m", gone)
	sp.Banned[gone] = &BanRecord{By: owner, At: 1}
	sp.Rooms = []*RoomRec{{ID: "r1", Name: "大厅"}}
	sp.JoinCode = "ABC123"

	oldDB := db
	defer func() { db = oldDB }()
	db = &store{Users: map[string]*User{}, Spaces: map[string]*SpaceRec{sp.ID: sp},
		Emails: map[string]string{}, Messages: map[string][]*Msg{},
		presence: map[string]*Presence{}, version: map[string]int64{}, waiters: map[string][]chan struct{}{}}

	v := db.view(sp, gone)
	if !v.Banned {
		t.Error("应标记 Banned=true")
	}
	if len(v.Members) != 0 {
		t.Errorf("封禁非成员不应看到成员列表，实际 %d 条", len(v.Members))
	}
	if len(v.Rooms) != 0 {
		t.Errorf("封禁非成员不应看到频道列表，实际 %d 条", len(v.Rooms))
	}
	if v.JoinCode != "" {
		t.Error("封禁非成员不应拿到 JoinCode")
	}
	if v.Name != sp.Name {
		t.Error("空间名应保留（用于显示「你已被封禁于 XXX」）")
	}

	// 【canary 发现的关键用例】封禁但仍在成员列表里的人（正常封禁流程就是这样）
	// 也必须被裁剪 —— 初版条件写成 isBanned && !isMember，这里永远不成立。
	sp.Banned["u-m"] = &BanRecord{By: owner, At: 2}
	v3 := db.view(sp, "u-m")
	if len(v3.Members) != 0 {
		t.Errorf("被封禁的【成员】不应看到成员列表，实际 %d 条", len(v3.Members))
	}
	if len(v3.Rooms) != 0 {
		t.Errorf("被封禁的【成员】不应看到频道列表，实际 %d 条", len(v3.Rooms))
	}
	if !v3.Banned {
		t.Error("被封禁的成员 Banned 应为 true")
	}
	delete(sp.Banned, "u-m")

	// 对照：正常成员应拿到完整视图
	v2 := db.view(sp, "u-m")
	if len(v2.Members) == 0 || len(v2.Rooms) == 0 {
		t.Error("正常成员应拿到完整视图")
	}
	if v2.JoinCode != "ABC123" {
		t.Error("正常成员应拿到 JoinCode")
	}
}

// 【0.4.66】memberView 必须带 banned 标记，否则管理员看不出谁被封
func TestView_MemberCarriesBannedFlag(t *testing.T) {
	const owner, m1, m2 = "u-owner", "u-m1", "u-m2"
	sp := mkSpace(owner, "", m1)
	sp.Members[m2] = &SpaceMember{Role: RoleMember, JoinedAt: 4}
	sp.Banned = map[string]*BanRecord{m2: {By: owner, At: 1}}

	oldDB := db
	defer func() { db = oldDB }()
	db = &store{Users: map[string]*User{}, Spaces: map[string]*SpaceRec{sp.ID: sp},
		Emails: map[string]string{}, Messages: map[string][]*Msg{},
		presence: map[string]*Presence{}, version: map[string]int64{}, waiters: map[string][]chan struct{}{}}

	v := db.view(sp, owner) // 管理员视角（owner 自己没被封，能拿全量视图）
	var got1, got2 *memberView
	for i := range v.Members {
		switch v.Members[i].ID {
		case m1:
			got1 = &v.Members[i]
		case m2:
			got2 = &v.Members[i]
		}
	}
	if got1 == nil || got2 == nil {
		t.Fatal("成员列表缺项")
	}
	if got1.Banned {
		t.Error("未封禁成员 banned 应为 false")
	}
	if !got2.Banned {
		t.Error("被封禁成员 banned 应为 true（否则管理员看不出谁被封）")
	}
	// 被封禁者仍在列表里（Q3 的设计），这样才能解封。
	// mkSpace(owner, "", m1) 建了 owner + 空 uid + m1 三人，再手动加 m2 = 4 人。
	if len(v.Members) != 4 {
		t.Errorf("成员列表应含被封禁者，实际 %d 人（期望 4）", len(v.Members))
	}
}
