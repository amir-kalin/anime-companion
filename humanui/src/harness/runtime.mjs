// Assembles the layers into one runnable thing.
//
// Order matters here and follows the dependency chain: a browser process, a CDP session on it, the
// accessibility index that session feeds, the page object that speaks both grounding channels, the
// approval broker the page gates on, and finally the sandbox the model's program runs inside. Only
// once the sandbox exists can a run start, which is why creation is async and explicit.

import { launchBrowser } from '../cdp/client.mjs';
import { AccessibilityIndex } from '../cdp/snapshot.mjs';
import { Page, UrlPolicy } from '../cdp/page.mjs';
import { NetworkGuard } from '../cdp/network.mjs';
import { Sandbox } from '../runtime/sandbox.mjs';
import { ApprovalBroker } from '../agent/approvals.mjs';

export async function createRuntime({
  width = 1440,
  height = 900,
  headless = true,
  allowHosts = null,
  allowOrigins = null,
  allowPrivateHosts = false,
  approvalMode = 'ask',
  autoAllowAfterMs = 15_000,
  approvalTimeoutMs = 120_000,
  stepTimeoutMs = 15_000,
  wallTimeoutMs = 30_000,
  onEvent = () => {},
  onApprovalRequest = () => {},
} = {}) {
  const browser = await launchBrowser({ width, height, headless });

  const accessibility = new AccessibilityIndex(browser.session);
  const broker = new ApprovalBroker({
    onRequest: onApprovalRequest,
    autoAllowAfterMs,
    timeoutMs: approvalTimeoutMs,
    policy: { mode: approvalMode },
  });

  // Enforced below the navigation check, so subresources and redirect hops are covered too.
  const guard = new NetworkGuard({
    allowHosts,
    allowOrigins,
    allowPrivate: allowPrivateHosts,
    onDecision: (d) => onEvent({ channel: 'network', ...d }),
  });
  await guard.attach(browser.session);

  const page = new Page(browser.session, {
    accessibility,
    urlPolicy: new UrlPolicy({ allowHosts }),
    network: guard,
    onRisk: broker.handler(),
    port: browser.port,
    onEvent: (e) => onEvent({ channel: 'page', ...e }),
  });

  // A navigation invalidates every outstanding handle; keep the index in step.
  browser.session.on((method) => {
    if (method === 'Page.frameNavigated') accessibility.reset();
  });

  const sandbox = new Sandbox({ page, stepTimeoutMs, wallTimeoutMs });

  return {
    browser,
    session: browser.session,
    page,
    sandbox,
    broker,
    accessibility,
    guard,
    /** Network decisions, for the operator UI and for tests. */
    networkStats: () => ({ ...guard.stats, blockedRequests: [...guard.stats.blockedRequests] }),
    async close() {
      await guard.detach();
      await browser.close();
    },
  };
}