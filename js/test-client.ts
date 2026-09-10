// js/test-client.ts
//
// هذا الملف لا يُنشر على Cloudflare — فقط للتجربة من متصفح لاحقًا.
// يثبت أن Phase 0 يعمل: اتصال آمن، HELLO/PING يعملان، MOVE يُرفض.

async function testPhase0(workerBaseUrl: string, telegramInitData: string) {
  const authRes = await fetch(`${workerBaseUrl}/auth/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: telegramInitData }),
  });
  if (!authRes.ok) {
    console.error("Auth failed:", await authRes.text());
    return;
  }
  const { gameToken, matchId } = await authRes.json();
  console.log("Got game token for match:", matchId);

  const wsUrl =
    workerBaseUrl.replace(/^http/, "ws") + `/match/connect?token=${gameToken}&matchId=${matchId}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected. Sending HELLO...");
    ws.send(JSON.stringify({ type: "HELLO", seq: 0, clientVersion: "0.0.1" }));
  };

  ws.onmessage = (event) => {
    console.log("Received:", event.data);
    const msg = JSON.parse(event.data as string);
    if (msg.type === "WELCOME") ws.send(JSON.stringify({ type: "PING", seq: 1 }));
    if (msg.type === "PONG") ws.send(JSON.stringify({ type: "MOVE", seq: 2, dx: 1, dy: 0 }));
  };

  ws.onerror = (err) => console.error("WebSocket error:", err);
  ws.onclose = (event) => console.log("Closed:", event.code, event.reason);
}

export { testPhase0 };
