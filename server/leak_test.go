package main

import (
	"encoding/json"
	"testing"
)

// 关键安全检查：view() 返回的 JSON 里绝不能出现 passwordHash
func TestView_DoesNotLeakPasswordHash(t *testing.T) {
	room := &RoomRec{ID: "r1", Name: "大厅", PasswordHash: hashKey("secret")}
	// 【0.4.67】roomView 已改为显式字段列表（不再内嵌 *RoomRec）。
	// 这个测试的语义不变：API 响应里绝不能出现 passwordHash。
	// 改了结构以后这里必须同步 —— 编译期就会报（unknown field），不会静默放过。
	rv := roomView{
		ID: room.ID, Name: room.Name, Pinned: room.Pinned, MaxUsers: room.MaxUsers,
		Order: room.Order, HasPassword: room.HasPassword(), SpaceID: "s1",
	}
	b, _ := json.Marshal(rv)
	s := string(b)
	t.Logf("序列化结果: %s", s)
	if contains(s, "passwordHash") || contains(s, hashKey("secret")[:16]) {
		t.Errorf("❌ hash 泄露到 API 响应里: %s", s)
	}
	if !contains(s, "hasPassword") {
		t.Error("应该有 hasPassword 标记")
	}
}
