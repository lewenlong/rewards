const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = readFileSync(join(__dirname, '..', 'auto.user.js'), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, `Missing function: ${name}`);
    return source.slice(match.index, source.indexOf('\n}\n', match.index) + 3);
}

function clock() {
    let now = 10000;
    let id = 0;
    const timers = new Map();
    const schedule = (fn, ms, repeat) => {
        timers.set(++id, { fn, ms, repeat, next: now + ms });
        return id;
    };
    return {
        globals: {
            Date: class extends Date { static now() { return now; } },
            setInterval: (fn, ms) => schedule(fn, ms, true),
            setTimeout: (fn, ms) => schedule(fn, ms, false),
            clearInterval: id => timers.delete(id),
            clearTimeout: id => timers.delete(id)
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const entry = [...timers].sort((a, b) => a[1].next - b[1].next)[0];
                if (!entry || entry[1].next > target) break;
                const [key, timer] = entry;
                now = timer.next;
                if (timer.repeat) timer.next += timer.ms;
                else timers.delete(key);
                timer.fn();
            }
            now = target;
        },
        timers
    };
}

function harness(storage = new Map(), time = clock()) {
    if (!storage.has('searchRunGeneration')) storage.set('searchRunGeneration', 1);
    storage.set('customClickSearchResults', true);
    const state = { isRunning: true, timers: new Set(), searchResultTabs: new Set(), cancelSearchPause: null };
    let resultsVisible = false;
    const resultsNode = { textContent: '搜索结果' };
    const fields = [];
    const form = {
        method: 'get',
        querySelectorAll: () => fields,
        appendChild(field) { fields.push(field); },
        requestSubmit() {
            const url = new URL('https://www.bing.com/search');
            url.searchParams.set('q', input.value);
            fields.forEach(field => url.searchParams.set(field.name, field.value));
            context.window.location = url;
        }
    };
    const input = {
        value: '', type: 'search', disabled: false, form,
        focus() {}, dispatchEvent() {}, getClientRects: () => [{}]
    };
    const context = vm.createContext({
        ...time.globals, URL, URLSearchParams, Uint8Array, crypto: webcrypto, console,
        state, CONFIG: { clickSearchResults: true },
        window: { location: new URL('https://www.bing.com/search?q=test&task=1') },
        document: {
            querySelector: selector => selector === '#b_results' ? (resultsVisible ? resultsNode : null) : input,
            createElement: () => ({})
        },
        GM_getValue: (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback,
        GM_setValue: (key, value) => storage.set(key, structuredClone(value)),
        GM_deleteValue: key => storage.delete(key),
        GM_log() {},
        updateStatusPanel() {},
        isCurrentSearchRun: generation => state.isRunning && storage.get('searchRunGeneration') === generation,
        typeSearchWord: async (box, word) => { box.value = word; return true; },
        stopSearchWithError: message => { storage.delete('pendingSearchSubmission'); state.isRunning = false; state.error = message; },
        executeSearch: generation => { state.resumedGeneration = generation; },
        getExecutionRegion: () => 'cn',
        EXECUTION_REGIONS: { cn: { language: 'zh-CN' } },
        getNextPauseAt: () => storage.get('nextPauseAt') ?? 2,
        findLinkFromSearchResults: () => ({ href: 'https://example.org/article#section' }),
        utils: {
            getRandomStartParam: () => 'task',
            getRandomPauseTime: () => 1000,
            getRandomPauseInterval: () => 3,
            addTimer: id => { state.timers.add(id); return id; },
            clearAllTimers: () => time.timers.clear()
        }
    });
    const names = ['setSearchFormField', 'performSearch', 'monitorSubmittedSearch', 'settlePendingSearch',
        'waitForSearchPause', 'openSearchResult', 'closeOpenedSearchResultTabs'];
    vm.runInContext(names.map(functionSource).join('\n'), context);
    return { context, storage, time, state, input, form, fields, resultsNode,
        setResultsVisible: visible => { resultsVisible = visible; } };
}

test('组末搜索提交表单，结果页确认后计数并开始暂停', async () => {
    const h = harness();
    h.storage.set('searchCount', 1);
    await h.context.performSearch('组末联想词', { currentCount: 1, maxCount: 10 }, 1);
    assert.equal(h.context.window.location.searchParams.get('q'), '组末联想词');
    assert.equal(h.context.window.location.searchParams.get('cc'), 'cn');
    assert.equal(h.context.window.location.searchParams.get('setlang'), 'zh-CN');
    assert.equal(h.storage.get('searchCount'), 1, '结果页确认前不计数');
    assert.equal(h.context.settlePendingSearch(1, 'task', h.context.window.location.searchParams), true);
    assert.equal(h.storage.get('searchCount'), 2);
    assert.equal(h.context.settlePendingSearch(1, 'task', h.context.window.location.searchParams), false);
    assert.equal(h.storage.get('searchCount'), 2, '结果页再次检查不能重复计数');
    assert.equal(h.storage.get('searchPauseState').resumeAt, 0);
    const pending = h.context.waitForSearchPause(1);
    assert.equal(h.storage.get('searchPauseState').resumeAt, 11000);
    h.time.advance(1000);
    assert.equal(await pending, true);
    assert.equal(h.storage.get('nextPauseAt'), 5);
    assert.equal(h.storage.has('searchPauseState'), false);
});

test('刷新恢复相同截止时间，终止会结束等待且不推进下一组', async () => {
    const h = harness();
    h.storage.set('searchCount', 1);
    await h.context.performSearch('词', { currentCount: 1, maxCount: 10 }, 1);
    h.context.settlePendingSearch(1, 'task', h.context.window.location.searchParams);
    const pending = h.context.waitForSearchPause(1);
    h.time.advance(400);
    const deadline = h.storage.get('searchPauseState').resumeAt;
    h.state.cancelSearchPause();
    assert.equal(await pending, false);
    const resumed = harness(h.storage, h.time);
    const next = resumed.context.waitForSearchPause(1);
    assert.equal(h.storage.get('searchPauseState').resumeAt, deadline);
    resumed.storage.set('searchRunGeneration', 2);
    resumed.time.advance(1000);
    assert.equal(await next, false);
    assert.equal(resumed.storage.has('nextPauseAt'), false);
});

test('最终一次搜索不增加组间暂停，旧任务不能再提交', async () => {
    const h = harness();
    h.storage.set('searchCount', 1);
    await h.context.performSearch('最后一词', { currentCount: 1, maxCount: 2 }, 1);
    h.context.settlePendingSearch(1, 'task', h.context.window.location.searchParams);
    assert.equal(h.storage.has('searchPauseState'), false);
    const url = h.context.window.location.href;
    h.storage.set('searchRunGeneration', 2);
    await h.context.performSearch('过期', { currentCount: 2, maxCount: 10 }, 1);
    assert.equal(h.context.window.location.href, url);
    assert.equal(h.storage.get('searchCount'), 2);
});

test('输入操作逐字更新 Bing 搜索框，而不是导航到拼接的搜索 URL', async () => {
    const values = [];
    const input = {
        value: '旧搜索词',
        focus() {},
        dispatchEvent(event) { if (event.type === 'input') values.push(this.value); }
    };
    const context = vm.createContext({
        Event: class { constructor(type) { this.type = type; } },
        setTimeout: callback => callback(),
        isCurrentSearchRun: () => true,
        Math
    });
    vm.runInContext(functionSource('typeSearchWord'), context);
    assert.equal(await context.typeSearchWord(input, '你好🙂', 1), true);
    assert.deepEqual(values, ['', '你', '你好', '你好🙂']);
});

test('缺失搜索框或结果词不匹配时停止，不计入搜索次数', async () => {
    const missing = harness();
    missing.context.document.querySelector = () => null;
    await missing.context.performSearch('测试', { currentCount: 0, maxCount: 10 }, 1);
    assert.match(missing.state.error, /未找到可用/);
    assert.equal(missing.storage.has('searchCount'), false);

    const mismatch = harness();
    await mismatch.context.performSearch('预期词', { currentCount: 0, maxCount: 10 }, 1);
    mismatch.context.window.location.searchParams.set('q', '其他词');
    assert.equal(mismatch.context.settlePendingSearch(1, 'task', mismatch.context.window.location.searchParams), null);
    assert.equal(mismatch.storage.has('searchCount'), false);
    assert.match(mismatch.state.error, /不一致/);
});

test('Bing 未保留隐藏启动字段时，仅在结果页确认后补回标记', async () => {
    const h = harness();
    h.form.requestSubmit = () => {
        h.context.window.location = new URL(`https://www.bing.com/search?q=${encodeURIComponent(h.input.value)}`);
    };
    h.context.window.history = {
        state: null,
        replaceState(_state, _title, url) { h.context.window.location = new URL(url); }
    };
    await h.context.performSearch('词', { currentCount: 0, maxCount: 10 }, 1);
    assert.equal(h.context.window.location.searchParams.has('task'), false);
    assert.equal(h.context.settlePendingSearch(1, 'task', h.context.window.location.searchParams), true);
    assert.equal(h.context.window.location.searchParams.get('task'), '1');
    assert.equal(h.storage.get('searchCount'), 1);
});

test('提交表单但未确认对应结果页时超时停止且不计数', async () => {
    const h = harness();
    h.form.requestSubmit = () => {};
    await h.context.performSearch('测试', { currentCount: 0, maxCount: 10 }, 1);
    h.time.advance(15000);
    assert.match(h.state.error, /未确认对应的结果页/);
    assert.equal(h.storage.has('searchCount'), false);
    assert.equal(h.storage.has('pendingSearchSubmission'), false);
});

test('同页更新 URL 和搜索结果时确认搜索并继续任务', async () => {
    const h = harness();
    await h.context.performSearch('同页搜索', { currentCount: 0, maxCount: 10 }, 1);
    assert.equal(h.storage.has('searchCount'), false);
    h.setResultsVisible(true);
    h.time.advance(250);
    assert.equal(h.storage.get('searchCount'), 1);
    assert.equal(h.storage.has('pendingSearchSubmission'), false);
    assert.equal(h.state.error, undefined);
    h.time.advance(2000);
    assert.equal(h.state.resumedGeneration, 1);
});

test('仅 URL 更新而结果尚未显示时不提前计数', async () => {
    const h = harness();
    await h.context.performSearch('等待结果', { currentCount: 0, maxCount: 10 }, 1);
    h.time.advance(500);
    assert.equal(h.storage.has('searchCount'), false);
    h.setResultsVisible(true);
    h.time.advance(250);
    assert.equal(h.storage.get('searchCount'), 1);
});

test('旧结果容器尚未更新时不提前计数', async () => {
    const h = harness();
    h.setResultsVisible(true);
    h.resultsNode.textContent = '旧查询的结果';
    await h.context.performSearch('新查询', { currentCount: 0, maxCount: 10 }, 1);
    h.time.advance(250);
    assert.equal(h.storage.has('searchCount'), false);
    h.resultsNode.textContent = '新查询的结果';
    h.time.advance(250);
    assert.equal(h.storage.get('searchCount'), 1);
});

test('表单提交抛错时停止且不计数', async () => {
    const h = harness();
    h.form.requestSubmit = () => { throw new Error('blocked'); };
    await h.context.performSearch('测试', { currentCount: 0, maxCount: 10 }, 1);
    assert.match(h.state.error, /提交失败/);
    assert.equal(h.storage.has('searchCount'), false);
    assert.equal(h.storage.has('pendingSearchSubmission'), false);
});

test('搜索主流程等待结果浏览和组间暂停结束后，才准备下一次搜索', async () => {
    const h = harness();
    const events = [];
    let finishReading;
    let finishPause;
    h.state.isRunning = false;
    h.state.searchWords = ['下一首词'];
    Object.assign(h.context, {
        isTaskTerminatedToday: () => false,
        createStatusPanel() {},
        getTaskStatus: () => ({ currentCount: 2, maxCount: 10, isCompleted: false }),
        openSearchResult: () => { events.push('read'); return new Promise(resolve => { finishReading = resolve; }); },
        waitForSearchPause: () => { events.push('pause'); return new Promise(resolve => { finishPause = resolve; }); },
        getGroupedSearchWord: async () => { events.push('word'); return '下一首词'; },
        document: { querySelector: () => null },
        AppTaskRunner: { runRandomReads: () => Promise.resolve() },
        performSearch: () => events.push('search')
    });
    h.context.utils.processSearchWord = word => word;
    h.context.utils.getRandomDelay = () => 100;
    h.context.utils.clearAllTimers = () => h.time.timers.clear();
    vm.runInContext(functionSource('executeSearch'), h.context);
    const execution = h.context.executeSearch(1);
    assert.deepEqual(events, ['read']);
    finishReading();
    await new Promise(setImmediate);
    assert.deepEqual(events, ['read', 'pause']);
    assert.equal(h.time.timers.size, 0);
    finishPause(true);
    await execution;
    assert.deepEqual(events, ['read', 'pause', 'word']);
    h.time.advance(100);
    await new Promise(setImmediate);
    assert.deepEqual(events, ['read', 'pause', 'word', 'search']);
});

function openFakeTab(h) {
    let opened;
    h.context.GM_openInTab = (url, options) => {
        assert.equal(options.active, true);
        opened = {
            url, closed: false, onclose: null,
            close() { this.closed = true; this.onclose?.(); }
        };
        return opened;
    };
    return () => opened;
}

function readerPage(h, url, blocks = []) {
    const scrolls = [];
    const menu = [];
    const handlers = new Map();
    const events = target => ({
        addEventListener(type, callback) {
            const key = `${target}:${type}`;
            if (!handlers.has(key)) handlers.set(key, new Set());
            handlers.get(key).add(callback);
        },
        removeEventListener(type, callback) { handlers.get(`${target}:${type}`)?.delete(callback); }
    });
    const child = {
        ...events('window'),
        location: new URL(url), scrollY: 0, innerHeight: 600,
        getSelection: () => ({ isCollapsed: true }),
        getComputedStyle: () => ({ visibility: 'visible' }),
        scrollTo(options) { this.scrollY = options.top; scrolls.push(options.top); },
        matchMedia: () => ({ matches: false })
    };
    child.history = { state: {}, replaceState(_state, _title, url) { child.location = new URL(url); } };
    const elements = blocks.map(block => ({
        textContent: block.text || '', tagName: block.tag || 'P', parentElement: null,
        closest: () => null,
        getBoundingClientRect: () => ({
            top: block.top - child.scrollY, bottom: block.top + block.height - child.scrollY,
            height: block.height, width: 800
        })
    }));
    const content = {
        getBoundingClientRect: () => ({ top: -child.scrollY, bottom: 3200 - child.scrollY }),
        querySelectorAll: () => elements
    };
    const document = {
        ...events('document'), hidden: false, activeElement: null,
        documentElement: { scrollHeight: 3200 }, body: content, querySelector: () => content
    };
    const childContext = vm.createContext({
        ...h.time.globals, URL, window: child,
        GM_getValue: h.context.GM_getValue, GM_setValue: h.context.GM_setValue,
        GM_registerMenuCommand: name => menu.push(name), document
    });
    return {
        child, childContext, document, scrolls, menu, handlers, elements,
        fire(target, type, event = {}) {
            handlers.get(`${target}:${type}`)?.forEach(callback => callback({ type, ...event }));
        }
    };
}

test('结果页加载后沿正文滚动；来源页等待浏览完成再关闭标签页', async () => {
    const h = harness();
    const tab = openFakeTab(h);
    let resolved = false;
    const browsing = h.context.openSearchResult(1).then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false);
    const key = [...h.storage.keys()].find(key => key.startsWith('search_result_read_'));
    const duration = h.storage.get(key).duration;
    const { child, childContext, menu, scrolls, handlers } = readerPage(h, tab().url);
    vm.runInContext(source, childContext);
    assert.equal(child.location.hash, '#section');
    assert.equal(menu.length, 1, '结果页只能注册浏览菜单');
    h.time.advance(7000);
    assert.ok(scrolls.length >= 2);
    assert.equal(tab().closed, false);
    h.time.advance(duration);
    await browsing;
    assert.equal(tab().closed, true);
    assert.equal(h.storage.has(key), false);
    assert.equal(h.state.searchResultTabs.size, 0);
    assert.equal(h.time.timers.size, 0);
    assert.ok([...handlers.values()].every(callbacks => callbacks.size === 0), '收尾需移除交互监听');
});

test('落点贴近下一段标题，正文密度与图片影响停留时长', () => {
    const h = harness();
    const page = readerPage(h, 'https://example.org/article', [
        { top: 0, height: 450, text: '正文内容' },
        { top: 470, height: 45, text: '下一节', tag: 'H2' }
    ]);
    vm.runInContext(functionSource('getResultReadingStep'), page.childContext);
    const short = page.childContext.getResultReadingStep();
    assert.equal(short.top, 398, '标题落在下一屏顶部留白处');
    page.elements[0].textContent = '正文内容'.repeat(80);
    const dense = page.childContext.getResultReadingStep();
    assert.ok(dense.dwell > short.dwell);
    page.elements[0].textContent = '';
    page.elements[0].tagName = 'IMG';
    assert.ok(page.childContext.getResultReadingStep().dwell > short.dwell);
    page.child.scrollY = 2600;
    assert.equal(page.childContext.getResultReadingStep().top, 2600, '到正文末尾后不继续滚动');
});

test('用户操作、选中文字与切后台时让出滚动，恢复可见后先停留', async () => {
    const h = harness();
    const tab = openFakeTab(h);
    const browsing = h.context.openSearchResult(1);
    const key = [...h.storage.keys()].find(key => key.startsWith('search_result_read_'));
    h.storage.get(key).duration = 30000;
    const page = readerPage(h, tab().url);
    vm.runInContext(source, page.childContext);
    h.time.advance(2500);
    assert.equal(page.scrolls.length, 1);
    page.fire('window', 'wheel');
    h.time.advance(4500);
    assert.equal(page.scrolls.length, 1);
    page.child.getSelection = () => ({ isCollapsed: false });
    h.time.advance(3000);
    assert.equal(page.scrolls.length, 1);
    page.child.getSelection = () => ({ isCollapsed: true });
    page.document.hidden = true;
    page.fire('document', 'visibilitychange');
    h.time.advance(3000);
    assert.equal(page.scrolls.length, 1);
    page.document.hidden = false;
    page.fire('document', 'visibilitychange');
    h.time.advance(1000);
    assert.equal(page.scrolls.length, 1, '回到前台不立即跳动');
    h.time.advance(3000);
    assert.ok(page.scrolls.length > 1);
    h.context.closeOpenedSearchResultTabs();
    h.time.advance(250);
    await browsing;
    assert.equal(h.time.timers.size, 0);
});

test('手动关页或终止任务能够结束浏览等待', async () => {
    for (const mode of ['manual', 'stop']) {
        const h = harness();
        const tab = openFakeTab(h);
        const browsing = h.context.openSearchResult(1);
        if (mode === 'manual') tab().close();
        else { h.state.isRunning = false; h.context.closeOpenedSearchResultTabs(); }
        await browsing;
        assert.equal(tab().closed, true);
        assert.equal(h.time.timers.size, 0);
        assert.equal(h.state.searchResultTabs.size, 0);
    }
});

test('目标页无法注入时超时收尾，不阻塞后续搜索', async () => {
    const h = harness();
    const tab = openFakeTab(h);
    const browsing = h.context.openSearchResult(1);
    const job = [...h.storage.entries()].find(([key]) => key.startsWith('search_result_read_'))[1];
    h.time.advance(job.expiresAt - h.time.globals.Date.now() + 500);
    await browsing;
    assert.equal(tab().closed, true);
    assert.equal(h.time.timers.size, 0);
});

test('普通网站和无效阅读标记不会启动任务或滚动', () => {
    for (const url of ['https://example.org/', `https://example.org/#rewardsReader=${'a'.repeat(32)}`]) {
        vm.runInNewContext(source, {
            URL, window: { location: new URL(url) },
            GM_getValue: () => null,
            setInterval: () => assert.fail('不应创建计时器'),
            GM_registerMenuCommand: () => assert.fail('不应注册搜索菜单')
        });
    }
});

test('CN 热词按热度取前 100 条，忽略旧版 50 条缓存', async () => {
    const h = harness();
    h.storage.set('cache_search_words_cn', { words: ['旧词'], time: 10000 });
    const input = Array.from({ length: 120 }, (_, index) => ({ keyword: `原词 ${index}`, heat: index }));
    Object.assign(h.context, {
        getExecutionRegion: () => 'cn', EXECUTION_REGIONS: { cn: {} }, getSearchTarget: () => 15,
        GM_xmlhttpRequest: request => {
            assert.equal(request.url, 'https://www.soureci.com/api/trends');
            request.onload({ responseText: JSON.stringify(input) });
        }
    });
    h.context.utils.shuffleArray = values => values;
    vm.runInContext(functionSource('fetchSearchKeywords'), h.context);
    const words = await h.context.fetchSearchKeywords();
    assert.equal(words.length, 100);
    assert.equal(words[0], '原词 119');
    assert.equal(words[99], '原词 20');
    assert.equal(h.storage.get('cache_search_words_cn').words.length, 100);
});
