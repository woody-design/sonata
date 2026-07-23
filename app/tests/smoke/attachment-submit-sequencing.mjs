import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CSI_U_ENTER,
  TerminalHost,
  attachmentChipEffectSatisfied,
} = require("../../dist/runtime");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attachment = { path: "/tmp/sonata-attachment-sequencing.png" };
const failures = [];

await check("literal prompt markers cannot satisfy attachment chip completion", async () => {
  const prompt = "Why did [Image #2] and [Image#3] come back?";
  assert.equal(
    attachmentChipEffectSatisfied(4, 6, 3, prompt),
    false,
    "two painted prompt literals alone cannot satisfy three attachments",
  );
  assert.equal(
    attachmentChipEffectSatisfied(4, 7, 3, prompt),
    false,
    "two prompt literals plus one chip cannot satisfy three attachments",
  );
  assert.equal(
    attachmentChipEffectSatisfied(4, 9, 3, prompt),
    true,
    "three attachment chips plus two rendered prompt literals satisfy the compensated threshold",
  );
  assert.equal(
    attachmentChipEffectSatisfied(0, 3, 3, "plain prompt"),
    true,
    "prompts without marker literals retain the N-chip threshold",
  );
  assert.equal(
    attachmentChipEffectSatisfied(0, 3, 3, "[Image #1] [Image #2]"),
    false,
    "a collapsed pasted-text placeholder leaves compensation unmet and uses the bounded fallback",
  );
});

await check("codex bare skill mention with attachments writes the probed second Enter", async () => {
  const { host, writes } = await startAttachmentSequence("codex", "$review");
  try {
    await waitForEnterCount(writes, 1);
    assert.equal(enterCount(writes), 1, "effect verification writes the first Enter");
    await delay(380);
    assert.equal(enterCount(writes), 2, "bare Codex mention receives the +320ms compensation Enter");
  } finally {
    host.dispose();
  }
});

await check("attachment compensation is absent for claude and non-mention text", async () => {
  for (const [provider, text] of [
    ["claude", "$review"],
    ["codex", "$review these images"],
  ]) {
    const { host, writes } = await startAttachmentSequence(provider, text);
    try {
      await waitForEnterCount(writes, 1);
      await delay(380);
      assert.equal(
        enterCount(writes),
        1,
        `${provider} ${JSON.stringify(text)} has no compensation Enter`,
      );
    } finally {
      host.dispose();
    }
  }
});

await check("inconclusive marker poll (snapshot read throws) never fires an EARLY Enter", async () => {
  // A snapshot READ FAILURE must not fall back to counting this.rawTail: the
  // linear PTY stream repaints the same marker, so a rawTail current count read
  // against a snapshot baseline inflates the delta toward an early Enter — the
  // one direction effect verification promises is impossible. On failure the
  // poll is inconclusive and the bounded timeout is the only floor.
  const writes = [];
  const host = new TerminalHost({
    taskId: "attachment-submit-inconclusive",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
  host.ptyProcess = {
    pid: 0,
    write(data) {
      writes.push(data);
    },
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
  // A live-looking mirror whose snapshot read THROWS on every poll.
  host.scrollback = {
    snapshot() {
      throw new Error("snapshot boom");
    },
    dispose() {},
    resize() {},
  };
  try {
    host.submitPrompt("why is this dark?", { attachments: [attachment] });
    // Paint a chip into rawTail: under the rejected fallback this WOULD satisfy
    // the effect (renderedDelta ≥ 1) and fire the Enter within ~170ms.
    await delay(70);
    host.rawTail = "[Image #1]";
    await delay(430); // ~500ms total — well past any early-satisfaction path
    assert.equal(
      enterCount(writes),
      0,
      "no early Enter — an inconclusive (thrown) snapshot poll never satisfies the effect",
    );
    // The bounded ATTACHMENT_EFFECT_TIMEOUT_MS floor still fires the Enter
    // (~1.5s after the paste), so an inconclusive poll delays but never strands.
    await delay(1300); // ~1.8s total — past the bounded fallback
    assert.equal(enterCount(writes), 1, "the bounded timeout is the floor that still submits");
  } finally {
    host.dispose();
  }
});

await check("stop cancels the attachment skill compensation Enter", async () => {
  const { host, writes } = await startAttachmentSequence("codex", "$review");
  try {
    await waitForEnterCount(writes, 1);
    const stopped = await host.stopRun({ inspectDelayMs: 500 });
    assert.equal(stopped.canceledPendingPromptWrite, true, "the compensation remains sequence-owned");
    await delay(380);
    assert.equal(enterCount(writes), 1, "no second Enter lands after cancellation");
  } finally {
    host.dispose();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log("attachment-submit-sequencing smoke passed");
}

async function startAttachmentSequence(provider, text) {
  const writes = [];
  const host = new TerminalHost({
    taskId: `attachment-submit-${provider}`,
    provider,
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
  host.ptyProcess = {
    pid: 0,
    write(data) {
      writes.push(data);
    },
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
  host.submitPrompt(text, { attachments: [attachment] });
  // The pre-paste baseline runs at 25ms. Paint one real chip after that
  // boundary and before the first effect check at text-paste +120ms.
  await delay(70);
  host.rawTail = "[Image #1]";
  return { host, writes };
}

async function waitForEnterCount(writes, expected) {
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    if (enterCount(writes) >= expected) {
      return;
    }
    await delay(5);
  }
  assert.fail(`timed out waiting for ${expected} Enter write(s); saw ${enterCount(writes)}`);
}

function enterCount(writes) {
  return writes.filter((write) => write === CSI_U_ENTER).length;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
