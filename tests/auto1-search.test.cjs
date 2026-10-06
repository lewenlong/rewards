const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'auto1.user.js'), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, `Missing function: ${name}`);
    return source.slice(match.index, source.indexOf('\n}\n', match.index) + 3);
}

function harness() {
    const storage = new Map([['searchRunGeneration', 1], ['searchCount', 2]]);
    const state = { isRunning: true };
    const context = vm.createContext({
        URL, URLSearchParams, Date, Math,
        EXECUTION_REGIONS: { us: { language: 'en-US' }, hk: { language: 'zh-HK' } },
        getExecutionRegion: () => 'us',
        utils: { getRandomStartParam: () => 'task', getRandomPauseTime: () => 60000 },
        window: { location: new URL('https://www.bing.com/?task=1') },
        document: { querySelector: () => null },
        state,
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        GM_deleteValue: key => storage.delete(key),
        GM_log() {},
        isCurrentSearchRun: generation => state.isRunning && storage.get('searchRunGeneration') === generation,
        getNextPauseAt: () => 3,
        monitorSubmittedSearch() {},
        stopSearchWithError: message => { state.error = message; },
    });
    vm.runInContext(['buildSearchUrl', 'performSearch', 'settlePendingSearch']
        .map(functionSource).join('\n'), context);
    return { context, storage, state };
}

test('auto1 使用 rewoards.js 风格参数并保留地区和启动标记', () => {
    const { context } = harness();
    const url = new URL(context.buildSearchUrl('weather today'));
    assert.equal(url.origin, 'https://www.bing.com');
    assert.equal(url.pathname, '/search');
    for (const [key, value] of Object.entries({
        q: 'weather today', form: 'QBLH', sp: '-1', lq: '0', pq: 'weather today',
        qs: 'n', sk: '', cc: 'us', setlang: 'en-US', task: '1'
    })) {
        assert.equal(url.searchParams.get(key), value, key);
    }
    assert.match(url.searchParams.get('sc'), /^\d+-13$/);
    assert.ok(url.searchParams.get('cvid'));
});

test('auto1 直接跳转 URL，结果页确认前不计数，确认后沿用组末暂停', () => {
    const { context, storage } = harness();
    assert.doesNotMatch(functionSource('performSearch'), /requestSubmit|typeSearchWord/);
    context.performSearch('weather today', { currentCount: 2, maxCount: 15 }, 1);
    assert.equal(context.window.location.pathname, '/search');
    assert.equal(context.window.location.searchParams.get('q'), 'weather today');
    assert.equal(storage.get('searchCount'), 2);
    assert.equal(storage.get('pendingSearchSubmission').nextCount, 3);
    assert.equal(context.settlePendingSearch(1, 'task', context.window.location.searchParams), true);
    assert.equal(storage.get('searchCount'), 3);
    assert.equal(storage.get('searchPauseState').afterCount, 3);
    assert.equal(storage.get('searchPauseState').duration, 60000);
    assert.equal(storage.has('pendingSearchSubmission'), false);
});

test('旧任务不能再触发搜索跳转', () => {
    const { context, storage } = harness();
    const before = context.window.location.href;
    storage.set('searchRunGeneration', 2);
    context.performSearch('stale', { currentCount: 2, maxCount: 15 }, 1);
    assert.equal(context.window.location.href, before);
    assert.equal(storage.has('pendingSearchSubmission'), false);
});
