// Second file of the timing fixture: one 150 ms test, so a run of both files shows two different entries.
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

test('quick', async () => { await sleep(150); });
