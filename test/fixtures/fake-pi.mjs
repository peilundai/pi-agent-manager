// Minimal stand-in for `pi --mode rpc` used by rpc-client tests.
let buffer = "";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "get_state") write({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1", text: "a b" } });
    else if (command.type === "prompt") {
      write({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      write({ type: "agent_start" });
      // Split one record across two writes to exercise buffering.
      const record = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi there" } });
      process.stdout.write(record.slice(0, 10));
      setTimeout(() => {
        process.stdout.write(`${record.slice(10)}\r\n`);
        write({ type: "agent_settled", aborted: false });
      }, 10);
    } else if (command.type === "crash") {
      process.stderr.write("boom\n");
      process.exit(3);
    } else write({ id: command.id, type: "response", command: command.type, success: false, error: `Unknown command: ${command.type}` });
  }
});
process.stdin.on("end", () => process.exit(0));
