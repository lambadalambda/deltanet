import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { type DeltaChatTransport } from '../../src/transport/deltachat.js';
import { openRelayTransport, register } from './relay.js';

/**
 * Real federation over chatmail (a local ephemeral podman relay by default,
 * or nine.testrun.org with HEADWATER_TEST_RELAY=testrun): alice publishes a
 * feed, bob follows it via the invite link, alice posts, bob sees the post.
 * Slow by nature (real SMTP/IMAP + securejoin handshake).
 */
describe('federation over chatmail', () => {
  const transports: DeltaChatTransport[] = [];

  afterAll(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });

  /**
   * Uses its own fresh accounts and data dirs (`data/int-basic-alice`,
   * `data/int-basic-bob`, two freshly registered chatmail accounts via
   * `registerAccount`) rather than `accounts.local.json` / `data/it-*`.
   *
   * This test used to rmSync `data/it-alice`/`data/it-bob` and reuse
   * long-lived credentials from `accounts.local.json` — those same data
   * dirs/credentials are also used by long-running daemon processes
   * (`data/main`, `data/demo`, `data/it-bob`), so running this suite wiped a
   * *live* daemon's database out from under it. See DEVLOG.
   */
  it('delivers a post from alice to her follower bob', async () => {
    rmSync('data/int-basic-alice', { recursive: true, force: true });
    rmSync('data/int-basic-bob', { recursive: true, force: true });

    const [aliceCreds, bobCreds] = await Promise.all([register(), register()]);

    const alice = await openRelayTransport('data/int-basic-alice', {
      addr: aliceCreds.addr,
      password: aliceCreds.password,
      displayName: 'int-basic-alice',
    });
    const bob = await openRelayTransport('data/int-basic-bob', {
      addr: bobCreds.addr,
      password: bobCreds.password,
      displayName: 'int-basic-bob',
    });
    transports.push(alice, bob);

    // bob follows alice's feed
    const invite = await alice.feedInvite();
    expect(invite).toMatch(/^(OPENPGP4FPR|https?):/i);
    const joinDone = alice.waitForEvent(
      'SecurejoinInviterProgress',
      120_000,
      (event) => event.progress === 1000,
    );
    await bob.follow(invite);
    await joinDone;

    // alice posts to her feed
    const text = `hello bob, this is post ${Date.now()}`;
    const posted = await alice.post(text);
    expect(posted.text).toBe(text);

    // the post arrives in bob's home timeline (poll: delivery is store-and-forward)
    const deadline = Date.now() + 180_000;
    let arrived;
    while (arrived === undefined && Date.now() < deadline) {
      const timeline = await bob.timeline({ limit: 20 });
      arrived = timeline.find((msg) => msg.text === text);
      if (arrived === undefined) await new Promise((r) => setTimeout(r, 3000));
    }
    expect(arrived).toBeDefined();
    expect(arrived?.sender.address).toBe(aliceCreds.addr);
    expect(arrived?.showPadlock).toBe(true); // e2e encrypted
  }, 300_000);

  /**
   * Regression test for the unfollow -> re-follow bug: `unfollow()` uses
   * `blockChat`, which correctly hides the feed, but re-following the same
   * feed afterward used to silently fail because `secureJoin` hands back
   * the *same* (still-blocked) chat id and the old `follow()` swallowed
   * `acceptChat`'s error instead of actually unblocking the underlying
   * contact.
   *
   * Uses its own fresh accounts and data dirs (`data/int-alice`,
   * `data/int-bob`, two freshly registered chatmail accounts via
   * `registerAccount`) so it can never contend with the `data/int-basic-*`
   * dirs used by the test above, or with any long-running daemon processes
   * holding `data/main`/`data/demo`/etc. open.
   */
  it('lets a follower re-follow a feed after unfollowing it', async () => {
    rmSync('data/int-alice', { recursive: true, force: true });
    rmSync('data/int-bob', { recursive: true, force: true });

    const [aliceCreds, bobCreds] = await Promise.all([register(), register()]);

    const alice = await openRelayTransport('data/int-alice', {
      addr: aliceCreds.addr,
      password: aliceCreds.password,
      displayName: 'int-alice',
    });
    const bob = await openRelayTransport('data/int-bob', {
      addr: bobCreds.addr,
      password: bobCreds.password,
      displayName: 'int-bob',
    });
    transports.push(alice, bob);

    // bob follows alice's feed
    const invite1 = await alice.feedInvite();
    const joinDone1 = alice.waitForEvent(
      'SecurejoinInviterProgress',
      120_000,
      (event) => event.progress === 1000,
    );
    await bob.follow(invite1);
    await joinDone1;

    const aliceContactId = (await bob.following()).find(
      (f) => f.addr === aliceCreds.addr,
    )?.contactId;
    expect(aliceContactId).toBeDefined();

    // alice posts; confirm bob receives it while following
    const firstText = `pre-unfollow post ${Date.now()}`;
    await alice.post(firstText);
    {
      const deadline = Date.now() + 120_000;
      let arrived;
      while (arrived === undefined && Date.now() < deadline) {
        const timeline = await bob.timeline({ limit: 20 });
        arrived = timeline.find((msg) => msg.text === firstText);
        if (arrived === undefined) await new Promise((r) => setTimeout(r, 3000));
      }
      expect(arrived).toBeDefined();
    }

    // bob unfollows alice
    const unfollowed = await bob.unfollow(aliceContactId!);
    expect(unfollowed).toBe(true);

    // alice posts again; this must NOT show up in bob's timeline
    const hiddenText = `post while unfollowed ${Date.now()}`;
    await alice.post(hiddenText);
    // Give delivery a beat to (not) happen, then assert absence.
    await new Promise((r) => setTimeout(r, 15_000));
    const timelineWhileUnfollowed = await bob.timeline({ limit: 20 });
    expect(timelineWhileUnfollowed.find((msg) => msg.text === hiddenText)).toBeUndefined();

    // bob re-follows alice via a fresh invite. Unlike the first join, bob
    // and alice already know/verified each other's key from the first
    // securejoin handshake, so the *inviter*-side progress event isn't a
    // reliable re-follow signal here (observed live: re-joining an
    // already-verified contact can complete without alice's side ever
    // re-emitting `SecurejoinInviterProgress` with progress===1000) — so
    // this wait is best-effort and the test falls through to polling
    // `bob.timeline()` below, which is what this regression actually cares
    // about (delivery resumes after re-follow).
    const invite2 = await alice.feedInvite();
    const joinDone2 = alice
      .waitForEvent('SecurejoinInviterProgress', 60_000, (event) => event.progress === 1000)
      .catch(() => undefined);
    await bob.follow(invite2);
    await joinDone2;

    // alice posts a new unique message; it must arrive in bob's timeline
    const refollowText = `post after refollow ${Date.now()}`;
    await alice.post(refollowText);
    const deadline = Date.now() + 120_000;
    let arrivedAfterRefollow;
    while (arrivedAfterRefollow === undefined && Date.now() < deadline) {
      const timeline = await bob.timeline({ limit: 20 });
      arrivedAfterRefollow = timeline.find((msg) => msg.text === refollowText);
      if (arrivedAfterRefollow === undefined) await new Promise((r) => setTimeout(r, 3000));
    }
    expect(arrivedAfterRefollow).toBeDefined();
    expect(arrivedAfterRefollow?.sender.address).toBe(aliceCreds.addr);
  }, 300_000);
});
