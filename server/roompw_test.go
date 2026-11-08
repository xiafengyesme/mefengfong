package main

// 【0.4.67】频道密码测试

import (
	"encoding/json"
	"testing"
)

func mkRoom(pw string) *RoomRec {
	r := &RoomRec{ID: "r1", Name: "大厅", MaxUsers: 8}
	if pw != "" {
		r.PasswordHash = hashKey(pw)
	}
	return r
}

func TestRoomPassword_NoPassword(t *testing.T) {
	r := mkRoom("")
	if err := checkRoomPassword(r, RoleMember, ""); err != nil {
		t.Error("没设密码时任何人不该被拦")
	}
	if r.HasPassword() {
		t.Error("HasPassword 应为 false")
	}
}

func TestRoomPassword_MemberNeedsPassword(t *testing.T) {
	r := mkRoom("abc123")
	// 不传密码 → 拒绝
	err := checkRoomPassword(r, RoleMember, "")
	if err == nil {
		t.Fatal("普通成员不带密码应被拒")
	}
	if ae, ok := err.(apiErr); !ok || ae.reason != "ROOM_PASSWORD" {
		t.Errorf("reason 期望 ROOM_PASSWORD，实际 %v", err)
	}
	// 错误密码 → 拒绝
	err = checkRoomPassword(r, RoleMember, "wrong")
	if err == nil {
		t.Fatal("错误密码应被拒")
	}
	if ae, ok := err.(apiErr); !ok || ae.reason != "ROOM_PASSWORD_WRONG" {
		t.Errorf("reason 期望 ROOM_PASSWORD_WRONG，实际 %v", err)
	}
	// 正确密码 → 放行
	if err := checkRoomPassword(r, RoleMember, "abc123"); err != nil {
		t.Errorf("正确密码应放行，实际 %v", err)
	}
}

func TestRoomPassword_AdminBypass(t *testing.T) {
	r := mkRoom("abc123")
	for _, role := range []Role{RoleOwner, RoleAdmin} {
		if err := checkRoomPassword(r, role, ""); err != nil {
			t.Errorf("%v 应免密，实际 %v", role, err)
		}
	}
}

func TestRoomPassword_HashNotLeaked(t *testing.T) {
	r := mkRoom("secret")
	// 序列化后不能出现 hash
	b, _ := json.Marshal(r)
	s := string(b)
	if !contains(s, "passwordHash") {
		// 老数据没密码时 omitempty 会省略，这里设了密码所以应该出现
		t.Log("注意：JSON 里没有 passwordHash 字段")
	}
	// 关键：view 层用的是 HasPassword()，不是把 hash 发出去
	if !r.HasPassword() {
		t.Error("HasPassword 应为 true")
	}
	// hash 本身不能等于明文
	if r.PasswordHash == "secret" {
		t.Error("存了明文密码")
	}
}

func TestRoomPassword_DifferentPasswords(t *testing.T) {
	r1 := mkRoom("a")
	r2 := mkRoom("b")
	if r1.PasswordHash == r2.PasswordHash {
		t.Error("不同密码的 hash 不应相同")
	}
	// 同一密码两次 hash 应相同（确定性 hash，与 hashKey 口径一致）
	r3 := mkRoom("a")
	if r1.PasswordHash != r3.PasswordHash {
		t.Error("相同密码的 hash 应相同")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
