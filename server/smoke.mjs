// 0.4.9 服务端冒烟：注册 → 建空间（默认语音房"大厅"）→ 语音房发文字（旧代码会 400）
// → 传截图 → 带图消息 → 拉消息 → 在线字段 → 图片回读
const B = 'http://127.0.0.1:18080';
const UID = 'smoke0000000000000001', KEY = 'a'.repeat(64);
const H = { 'X-Fong-Uid': UID, 'X-Fong-Key': KEY, 'Content-Type': 'application/json' };
let fail = 0;
const ck = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

let r = await fetch(B + '/api/register', { method: 'POST', headers: H, body: JSON.stringify({ ID: UID, Key: KEY, Name: 'Tester' }) });
ck('注册', r.ok, String(r.status));

r = await fetch(B + '/api/spaces', { method: 'POST', headers: H, body: JSON.stringify({ Name: '烟测空间' }) });
const sp = await r.json();
ck('建空间（默认大厅=语音房）', r.ok && sp.rooms && sp.rooms[0].name === '大厅', 'kind=' + (sp.rooms[0].kind || 'voice(空)'));
const sid = sp.id, rid = sp.rooms[0].id;

r = await fetch(`${B}/api/spaces/${sid}/rooms/${rid}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: '语音房里发文字' }) });
ck('语音房发文字（旧代码 400）', r.ok, String(r.status));

// 1x1 PNG（89 50 4E 47 头）
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==', 'base64');
r = await fetch(`${B}/api/spaces/${sid}/rooms/${rid}/images`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: png });
const up = await r.json();
ck('截图上传', r.ok && up.url && up.url.startsWith('/img/'), up.url);

r = await fetch(`${B}/api/spaces/${sid}/rooms/${rid}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: '看这张图', img: up.url }) });
ck('带图消息', r.ok, String(r.status));

r = await fetch(`${B}/api/spaces/${sid}/rooms/${rid}/messages?after=0`, { headers: H });
const ms = await r.json();
ck('拉消息（2 条，第 2 条带 img）', ms.messages && ms.messages.length === 2 && ms.messages[1].img === up.url);

r = await fetch(`${B}${up.url}`);
const got = Buffer.from(await r.arrayBuffer());
ck('图片回读字节一致', r.ok && got.equals(png), got.length + 'B');

r = await fetch(B + '/api/spaces/' + sid, { headers: H });
const v2 = await r.json();
const me = (v2.members || []).find(m => m.id === UID);
ck('成员在线字段（刚请求过 → online=true）', me && me.online === true);

r = await fetch(`${B}/api/spaces/${sid}/rooms/${rid}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ img: 'http://evil/x.png' }) });
ck('外链图片被拒', r.status === 400, String(r.status));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
