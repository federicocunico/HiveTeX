import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, uniq } from './helpers.js';

/** spec network-diagnostics: the page shows the checks, the co-author's connection and a peer test that connects. */
test('network diagnostics: checks, per-co-author details, peer test and a report without secrets', async ({ browser, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'net');
  const slug = await createProject(o.page, uniq('net-'));
  await addFile(o.page, 'main.tex');

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'netg');
  await joinProject(g.page, slug);
  await o.page.waitForFunction(() => ((window as unknown as { __p2p: { session: { peers: unknown[] } } }).__p2p.session.peers.length ?? 0) > 0, undefined, { timeout: 60_000 });

  await o.page.getByTestId('sync-status').click();
  await expect(o.page.getByTestId('sync-panel')).toBeVisible();
  await o.page.getByTestId('open-network').click();
  const dialog = o.page.getByTestId('network-dialog');
  await expect(dialog).toBeVisible();

  // every check reaches a verdict (the dev stack has no relay and no router: warnings and "not applicable" are fine)
  for (const id of ['signaling', 'ice-config', 'stun', 'relay', 'port-mapping']) {
    await expect(dialog.getByTestId(`net-check-${id}`)).not.toHaveAttribute('data-status', /^(idle|running)$/, { timeout: 40_000 });
  }
  await expect(dialog.getByTestId('net-check-signaling')).toHaveAttribute('data-status', /^(pass|warn)$/);
  await expect(dialog.getByTestId('net-check-port-mapping')).toHaveAttribute('data-status', 'na');
  await expect(dialog.getByTestId('net-check-relay')).toContainText(/relay/i);

  // the co-author is connected, and the peer test says so with the route
  await expect(dialog.getByTestId(`net-peer-${g.username}`)).toHaveAttribute('data-state', 'connected');
  await dialog.getByTestId(`net-test-${g.username}`).click();
  await expect(dialog.getByTestId(`net-verdict-${g.username}`)).toContainText(/Connected/, { timeout: 40_000 });
  // the test went through every stage: signaling round trip confirmed by the service, the other side's own view
  const probe = dialog.getByTestId(`net-probe-${g.username}`);
  await expect(probe).toHaveAttribute('data-outcome', 'connected');
  for (const label of ['Setup message sent', 'Accepted by the service', 'Delivered to the other device', 'Answer from the other device', 'Connection']) {
    await expect(probe).toContainText(label);
  }
  await expect(probe).toContainText(/knows this device; sees this device on the service/);

  // the live trace is shown on request
  await dialog.getByTestId('net-trace-toggle').click();
  await expect(dialog.getByTestId('net-trace')).toContainText('probe.end');

  // the report is copyable, holds the connection test and the trace, and no credentials
  await dialog.getByTestId('net-copy').click();
  const report = await o.page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (report) {
    expect(report).toContain('HiveTeX network report');
    expect(report).toContain(g.username);
    expect(report).toContain(`Connection test with ${g.username}`);
    expect(report).toContain('Connection trace (last');
    expect(report).not.toMatch(/credential|password|token/i);
  }
  await ownerCtx.close();
  await guestCtx.close();
});

test('network diagnostics outside a project: the account area page runs the network checks', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'netacc');
  await createProject(u.page, uniq('neta-'));
  await u.page.goto('/#/account');
  await u.page.getByTestId('network-link').getByRole('button', { name: 'Network diagnostics' }).click();
  const page = u.page.getByTestId('network-page');
  await expect(page).toBeVisible();
  await expect(page.getByTestId('net-check-ice-config')).not.toHaveAttribute('data-status', /^(idle|running)$/, { timeout: 40_000 });
  await expect(page.getByTestId('net-check-signaling')).toHaveAttribute('data-status', 'na');
  await expect(page.getByText('Open a project to see how this device connects')).toBeVisible();
  await ctx.close();
});
