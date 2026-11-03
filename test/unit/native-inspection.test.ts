/**
 * Feature: Native inspection — UiAutomator2 page source parsing, locator candidates, scoring, device verification
 * Layer: Unit — node:test
 * Real: page-source parser, candidate builder, scoring rules, verification logic
 * Mocked: the Appium session (a fake that answers findElements/rect from scripted results)
 * Guards: invented properties, a locator marked "verified" without asking the device, ambiguous or wrong-target
 *         locators recommended, unexplained scores, broken XPath/UiSelector quoting
 * Run: npm run test:unit
 * Needs: Node.js 22.18+
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_SCORE, candidatesFor, recommend, score, uiStr, verifyCandidates, xpathLiteral, type Candidate } from '../../src/engines/appium/native-locators.ts';
import { hitTest, parsePageSource } from '../../src/engines/appium/page-source.ts';
import type { Session } from '../../src/engines/appium/webdriver.ts';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" package="com.shop" class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]" displayed="true">
    <android.widget.LinearLayout index="0" package="com.shop" class="android.widget.LinearLayout" text="" resource-id="com.shop:id/row" bounds="[0,100][1080,300]">
      <android.widget.TextView index="0" package="com.shop" class="android.widget.TextView" text="Tom &amp; Jerry &quot;Deluxe&quot;" resource-id="com.shop:id/title" bounds="[20,120][800,180]" clickable="false" enabled="true" />
      <android.widget.Button index="1" package="com.shop" class="android.widget.Button" text="Edit" resource-id="com.shop:id/edit" content-desc="Edit item" bounds="[850,120][1050,200]" clickable="true" enabled="true" checkable="false" />
    </android.widget.LinearLayout>
    <android.widget.LinearLayout index="1" package="com.shop" class="android.widget.LinearLayout" text="" resource-id="com.shop:id/row" bounds="[0,300][1080,500]">
      <android.widget.TextView index="0" package="com.shop" class="android.widget.TextView" text="₹2,500 / set" resource-id="com.shop:id/price" bounds="[20,320][400,380]" />
      <android.widget.Button index="1" package="com.shop" class="android.widget.Button" text="Edit" resource-id="com.shop:id/edit" bounds="[850,320][1050,400]" clickable="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`;

const ps = parsePageSource(XML);

// Risk: properties are invented, or entities and positions are decoded wrongly.
// Given a UiAutomator2 source, When parsed, Then attributes, flags, bounds and absolute paths match the XML exactly.
test('page source parsing keeps exact attributes, flags, bounds and positional paths', () => {
  assert.equal(ps.width, 1080);
  assert.equal(ps.nodes.length, 7);
  const title = ps.nodes[2];
  assert.equal(title.text, 'Tom & Jerry "Deluxe"');
  assert.deepEqual(title.flags, { clickable: false, enabled: true }, 'only flags present in the XML are reported');
  assert.deepEqual(title.bounds, { x: 20, y: 120, w: 780, h: 60 });
  const edit2 = ps.nodes[6];
  assert.equal(edit2.path, '/hierarchy/android.widget.FrameLayout[1]/android.widget.LinearLayout[2]/android.widget.Button[1]');
  assert.equal(edit2.parent, 4);
  assert.deepEqual(ps.nodes[4].children, [5, 6]);
  assert.equal(hitTest(ps, 900, 350)?.index, 6);
  assert.throws(() => parsePageSource('<hierarchy rotation="0"></hierarchy>'), /no elements/);
});

test('UiSelector and XPath literals escape quotes correctly', () => {
  assert.equal(uiStr('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.equal(xpathLiteral("plain"), "'plain'");
  assert.equal(xpathLiteral("Tom's"), `"Tom's"`);
  assert.equal(xpathLiteral(`Tom's "x"`), `concat('Tom', "'", 's "x"')`);
});

// Risk: candidates are missing or come with misleading claims.
// Given the second (repeated-id) Edit button, When candidates are built, Then id, text, instance, XPath and coordinates are offered with honest local match counts.
test('candidates cover every strategy with local match counts', () => {
  const c = candidatesFor(ps.nodes[6], ps);
  const by = Object.fromEntries(c.map((x) => [x.strategy, x]));
  assert.deepEqual(Object.keys(by), ['id', 'uiautomator text', 'class + text', 'uiautomator id + instance', 'xpath attributes', 'xpath absolute', 'coordinates']);
  assert.equal(by.id.localMatches, 2, 'id repeats in both rows');
  assert.equal(by['uiautomator id + instance'].value, 'new UiSelector().resourceId("com.shop:id/edit").instance(1)');
  assert.equal(by.coordinates.python, 'driver.execute_script("mobile: clickGesture", {"x": 950, "y": 360})');
  assert.equal(by.coordinates.using, null);
  const price = candidatesFor(ps.nodes[5], ps);
  assert.ok(price.find((x) => x.strategy === 'uiautomator text')!.weaknesses.some((w) => w.includes('dynamic')));
});

/** WebView methods a native-only fake session never needs. */
function unusedWebMethods(): Pick<Session, 'executeArgs' | 'currentContext' | 'switchContext' | 'switchFrame' | 'windowHandles' | 'currentWindow' | 'switchWindow' | 'url' | 'title' | 'click' | 'clear' | 'sendKeys' | 'text'> {
  const no = async (): Promise<never> => {
    throw new Error('not used in native tests');
  };
  return { executeArgs: no, currentContext: no, switchContext: no, switchFrame: no, windowHandles: no, currentWindow: no, switchWindow: no, url: no, title: no, click: no, clear: no, sendKeys: no, text: no };
}

function fakeSession(answers: Record<string, { ids: string[]; rect?: { x: number; y: number; width: number; height: number } } | Error>): Session {
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
  return {
    id: 's1',
    capabilities: {},
    async findElements(using, value) {
      const a = answers[`${using}|${value}`];
      if (!a) return [];
      if (a instanceof Error) throw a;
      if (a.rect) a.ids.forEach((id) => rects.set(id, a.rect!));
      return a.ids;
    },
    rect: async (id) => rects.get(id) ?? { x: 0, y: 0, width: 1, height: 1 },
    attribute: async () => null,
    displayed: async () => true,
    enabled: async () => true,
    selected: async () => false,
    pageSource: async () => XML,
    screenshotPng: async () => Buffer.alloc(0),
    contexts: async () => ['NATIVE_APP'],
    windowRect: async () => ({ x: 0, y: 0, width: 1080, height: 2400 }),
    execute: async () => null,
    ...unusedWebMethods(),
    delete: async () => {},
  };
}

// Risk: a locator is called "verified" or recommended when the device found several, none, or another element.
// Given scripted device answers, When verified, Then statuses, match counts and the recommendation follow the device, not assumptions.
test('verification follows the device: unique, ambiguous, not found, wrong target, error', async () => {
  const node = ps.nodes[6];
  const here = { x: 850, y: 320, width: 200, height: 80 };
  const elsewhere = { x: 850, y: 120, width: 200, height: 80 };
  const s = fakeSession({
    'id|com.shop:id/edit': { ids: ['a', 'b'], rect: elsewhere },
    'xpath|//android.widget.Button[@resource-id=\'com.shop:id/edit\' and @text=\'Edit\']': { ids: ['c', 'd'], rect: elsewhere },
    '-android uiautomator|new UiSelector().resourceId("com.shop:id/edit").instance(1)': { ids: ['e'], rect: here },
    '-android uiautomator|new UiSelector().text("Edit")': { ids: ['f'], rect: elsewhere },
    '-android uiautomator|new UiSelector().className("android.widget.Button").text("Edit")': new Error('UiAutomator2 server crashed'),
  });
  const v = await verifyCandidates(s, node, candidatesFor(node, ps));
  const by = Object.fromEntries(v.map((x) => [x.strategy, x]));
  assert.equal(by.id.status, 'ambiguous');
  assert.equal(by.id.matchCount, 2);
  assert.equal(by['uiautomator id + instance'].status, 'verified-unique');
  assert.equal(by['uiautomator text'].status, 'wrong-target', 'one match, but it is the Edit button of the other row');
  assert.equal(by['class + text'].status, 'error');
  assert.match(by['class + text'].error!, /crashed/);
  assert.equal(by['xpath absolute'].status, 'not-found');
  assert.equal(by.coordinates.status, 'not-verifiable');
  assert.equal(recommend(v)?.strategy, 'uiautomator id + instance');
  assert.ok(v.every((x, i) => i === 0 || v[i - 1].score >= x.score), 'sorted by score');
});

// Risk: scores are arbitrary.
// Given each rule, When scored, Then the number changes by exactly the documented amount and the notes say why.
test('scoring rules are deterministic and explained', () => {
  const c = (strategy: Candidate['strategy'], weak: string[] = []): Candidate => ({ strategy, using: 'id', value: 'v', python: '', strengths: [], weaknesses: weak, localMatches: 1 });
  assert.equal(score(c('id'), 'verified-unique', 10, 3).score, BASE_SCORE.id + 10);
  assert.equal(score(c('id'), 'ambiguous', 10, 3).score, BASE_SCORE.id - 40);
  assert.equal(score(c('id'), 'not-found', 10, 3).score, 0);
  assert.equal(score(c('accessibility id', ['value looks dynamic (count, price or time) and may change between runs']), 'verified-unique', 10, 3).score, BASE_SCORE['accessibility id'] + 10 - 25);
  assert.equal(score(c('xpath absolute'), 'verified-unique', 1200, 9).score, BASE_SCORE['xpath absolute'] + 10 - 10 - 10);
  const r = score(c('uiautomator text'), 'verified-unique', 400, 2);
  assert.equal(r.score, BASE_SCORE['uiautomator text'] + 10 - 5);
  assert.deepEqual(r.notes, ['uiautomator text base 72', '+10 verified unique on the device', '-5 lookup slower than 300 ms']);
});
