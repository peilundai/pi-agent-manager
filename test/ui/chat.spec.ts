import { expect, test } from "./harness";

test.describe("Pi Agent Manager webview", () => {
  test("shows the empty state with the current model in both themes", async ({ chat }) => {
    const { page } = chat;
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Sonnet");
    await expect(page.getByRole("img", { name: "Pi" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Untitled" })).toBeDisabled();
    await chat.screenshot("empty-dark");
    await chat.setTheme("light");
    await chat.screenshot("empty-light");
  });

  test("runs a full tool-using turn with an approval dialog", async ({ chat }) => {
    const { page } = chat;
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Sonnet");
    const input = page.getByLabel("Message Pi");
    await input.fill("Fix the greeting in @src/greet.ts");
    await input.press("Enter");

    await expect(page.locator(".status-line")).toContainText("esc to interrupt");
    await expect(page.locator(".user-message")).toHaveText("Fix the greeting in @src/greet.ts");

    const dialog = page.getByRole("group", { name: "Allow bash command?" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".tool-header").filter({ hasText: "Read" })).toContainText("src/greet.ts");
    await expect(page.locator(".diff-add")).toContainText("return `Hello, ${name}!`;");
    await expect(page.locator(".diff-del")).toContainText('return "hello " + name;');
    await chat.screenshot("dialog-dark");
    await dialog.getByRole("button", { name: "Yes" }).click();

    await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
    await expect(page.locator(".status-line")).toHaveCount(0);
    await expect(page.locator(".dialog-receipt")).toContainText("Yes");
    await expect(page.locator(".tool-header").filter({ hasText: "Bash" })).toContainText("cat src/greet.ts && echo done");
    await expect(page.locator(".tool-success")).toHaveCount(3);
    await expect(page.locator(".header-title")).toHaveText("Fix the greeting in @src/greet.ts");
    await expect(page.locator(".markdown .hljs-keyword").first()).toBeVisible();
    await expect.poll(() => chat.pi.readGreet()).toContain("Hello, ${name}!");
    await chat.screenshot("done-dark");
    await chat.setTheme("light");
    await chat.screenshot("done-light");
  });

  test("opens the model picker and switches thinking level", async ({ chat }) => {
    const { page } = chat;
    await page.getByTitle("Choose model and thinking level").click();
    const picker = page.getByRole("dialog", { name: "Choose model" });
    await expect(picker.getByRole("option", { name: /Mock Haiku/ })).toBeVisible();
    await chat.screenshot("model-picker-dark");
    await picker.getByRole("radio", { name: "High" }).click();
    await expect(page.locator(".model-level")).toHaveText("High");
    await picker.getByRole("option", { name: /Mock Haiku/ }).click();
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Haiku");
    await expect(page.locator(".model-level")).toHaveCount(0);
  });

  test("offers slash commands and file mentions", async ({ chat }) => {
    const { page } = chat;
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Sonnet");
    const input = page.getByLabel("Message Pi");
    await input.fill("/");
    const commands = page.getByRole("listbox", { name: "Commands" });
    await expect(commands.getByRole("option", { name: /\/hello/ })).toBeVisible();
    await expect(commands.getByRole("option", { name: /\/compact/ })).toBeVisible();
    await chat.screenshot("slash-dark");
    await input.fill("/hello");
    await input.press("Escape");
    await input.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Hello from the extension!" })).toBeVisible();

    await input.fill("look at @gre");
    const files = page.getByRole("listbox", { name: "Files" });
    await expect(files.getByRole("option", { name: /greet\.ts/ })).toBeVisible();
    await input.press("Tab");
    await expect(input).toHaveValue("look at @src/greet.ts ");
  });

  test("lists and resumes past chats", async ({ chat }) => {
    const { page } = chat;
    const input = page.getByLabel("Message Pi");
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Sonnet");
    await input.fill("Give me a plain answer");
    await input.press("Enter");
    await expect(page.locator(".markdown")).toContainText("short answer");
    await expect(page.locator(".status-line")).toHaveCount(0);

    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("img", { name: "Pi" })).toBeVisible();

    await page.getByRole("button", { name: "Past chats" }).click();
    const picker = page.getByRole("dialog", { name: "Past chats" });
    await expect(picker.getByText("Today")).toBeVisible();
    await chat.screenshot("history-dark");
    await picker.getByRole("option", { name: /Give me a plain answer/ }).click();
    await expect(page.locator(".user-message")).toHaveText("Give me a plain answer");
    await expect(page.locator(".markdown")).toContainText("short answer");
  });

  test("interrupts Pi with Escape", async ({ chat }) => {
    const { page } = chat;
    const input = page.getByLabel("Message Pi");
    await expect(page.locator(".model-pill .model-name")).toHaveText("Mock Sonnet");
    await input.fill("Write something slow");
    await input.press("Enter");
    await expect(page.locator(".markdown")).toContainText("tick tick");
    await input.press("Escape");
    await expect(page.locator(".message-error")).toHaveText("Interrupted");
    await expect(page.locator(".status-line")).toHaveCount(0);
  });
});
