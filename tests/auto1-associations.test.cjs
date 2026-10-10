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
const associationBlock = source.slice(source.indexOf('const ASSOCIATION_RULE_VERSION'),
    source.indexOf('\n/**\n * 获取热门搜索词', source.indexOf('const ASSOCIATION_RULE_VERSION')));
assert.ok(associationBlock.includes('function isPreparedSearchQueryValid'));
const plain = value => JSON.parse(JSON.stringify(value));

// 小型 DOM fixture：容器和明确问题节点由测试提供，记录实际调用的选择器。
function element(text, attrs = {}, options = {}) {
    return {
        textContent: text, id: attrs.id || '', className: attrs.class || '',
        getAttribute: key => attrs[key] ?? null,
        closest: () => options.hidden ? {} : null,
        getClientRects: () => options.noRect ? [] : [{}],
        querySelector: () => options.label ? { textContent: options.label } : null,
        matches: () => /\b(?:b_paaQuestion|df_alask)\b/.test(attrs.class || ''),
        style: { display: options.display || 'block', visibility: options.visibility || 'visible' }
    };
}
function harness(currentCount = 1) {
    const storage = new Map([['searchRunGeneration', 1], ['searchCount', currentCount], ['nextPauseAt', 5]]);
    const state = { isRunning: true, searchWords: ['new topic'], preparedSearchQuery: null };
    const selectors = [];
    const dom = { paa: [], related: [], input: 'seed', results: true };
    const context = vm.createContext({
        URL, URLSearchParams, Date, Math, Set, Map,
        CONFIG: { requestTimeout: 1000 }, EXECUTION_REGIONS: { us: { language: 'en-US' } },
        state, getExecutionRegion: () => 'us', getRegionFallbackSearchWords: () => ['fallback topic'],
        utils: { getTodayStr: () => '2026-10-10', getRandomPauseInterval: () => 5 },
        window: { location: new URL('https://www.bing.com/search?q=seed'), getComputedStyle: el => el.style },
        document: {
            querySelector: selector => selector === '#b_results' ? (dom.results ? {} : null) :
                selector === '#sb_form_q' && dom.input !== null ? { value: dom.input } : null,
            querySelectorAll: selector => {
                selectors.push(selector);
                const nodes = selector.includes('peoplealsoask') ? dom.paa : dom.related;
                return [{ querySelectorAll: childSelector => { selectors.push(childSelector); return nodes; } }];
            }
        },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        // 模拟 GM 序列化，避免测试代码通过共享对象引用掩盖缓存写入竞态。
        GM_setValue: (key, value) => storage.set(key, plain(value)),
        GM_xmlhttpRequest: options => options.onload({ responseText: JSON.stringify(['seed', ['fresh suggestion']]) }),
        GM_log() {}, setTimeout: callback => { callback(); return 1; },
        isCurrentSearchRun: generation => state.isRunning && storage.get('searchRunGeneration') === generation
    });
    vm.runInContext(['fetchBingSuggestions', 'getSearchGroupStorageKey', 'getNextPauseAt']
        .map(functionSource).join('\n') + '\n' + associationBlock, context);
    return { context, storage, state, dom, selectors };
}
function group(overrides = {}) {
    return {
        date: '2026-10-10', region: 'us', runGeneration: 1, associationVersion: 1,
        startCount: 0, endCount: 5, seed: 'seed', queries: ['seed'], querySources: ['seed'],
        searchBoxSuggestions: [], peopleAlsoAsk: [], relatedSearches: [], pageAssociationsCollected: true,
        ...overrides
    };
}

test('集中拒绝简繁英文界面文案，包括空白、全角标点和不可见字符变体', () => {
    const { context } = harness();
    for (const word of ['搜索更多内容', '搜尋更多內容。', '告诉我们更多信息！', '告訴我們更多資訊',
        ' TELL US MORE... ', 'search more content', 'Ｓｅａｒｃｈ ｍｏｒｅ ｃｏｎｔｅｎｔ！', '搜索\u200b更多内容']) {
        for (const sourceName of ['suggestion', 'paa', 'related']) {
            assert.equal(context.normalizeAssociation(word, 'seed', sourceName), '', word);
        }
    }
    assert.equal(context.normalizeAssociation('normal query', 'seed'), '');
    assert.equal(context.normalizeAssociation('normal query', 'seed', 'unknown'), '');
});

test('不误伤真实年份、单字、无问号的问题和不同措辞，不改写词内空白', () => {
    const { context } = harness();
    for (const word of ['2026', '猫', 'how does it work', 'customer feedback software', 'weather  today', 'x'.repeat(100)]) {
        assert.equal(context.normalizeAssociation(word, 'seed', 'paa'), word);
    }
    assert.equal(context.normalizeAssociation('反馈', 'seed', 'suggestion'), '反馈');
    assert.equal(context.normalizeAssociation('反馈', 'seed', 'paa'), '');
    assert.equal(context.normalizeAssociation('ＳＥＥＤ！', 'seed', 'suggestion'), '');
});

test('搜索框联想只取结构化查询字段，过滤 UI 文案和归一化重复项', async () => {
    const { context } = harness();
    for (const response of [
        ['seed', ['seed', 'tell us more', 'Weather  today', 'weather today!', '反馈']],
        { AS: { Results: [{ Suggests: [{ Txt: 'seed' }, { Txt: 'tell us more' },
            { Txt: 'Weather  today' }, { Txt: 'weather today!' }, { Txt: '反馈' }, { Text: 'not a query' }] }] } }
    ]) {
        context.GM_xmlhttpRequest = options => options.onload({ responseText: JSON.stringify(response) });
        assert.deepEqual(plain(await context.fetchBingSuggestions('seed', 'us', 20)), ['Weather  today', '反馈']);
    }
    context.GM_xmlhttpRequest = () => assert.fail('limit=0 must not request');
    assert.deepEqual(plain(await context.fetchBingSuggestions('seed', 'us', 0)), []);
});

test('联想请求失败、超时、损坏响应和同步异常均返回空候选，不阻塞换组', async () => {
    const { context } = harness();
    for (const request of [
        options => options.onerror(), options => options.ontimeout(),
        options => options.onload({ responseText: 'not json' }),
        options => options.onload({ responseText: '{"AS":{"Results":{}}}' }),
        () => { throw new Error('request unavailable'); }
    ]) {
        context.GM_xmlhttpRequest = request;
        assert.deepEqual(plain(await context.fetchBingSuggestions('seed', 'us', 20)), []);
    }
});

test('队列不修改来源数组，重复项和无效项不会遮挡后面的有效词', () => {
    const { context } = harness();
    const saved = group({
        endCount: 8, searchBoxSuggestions: ['seed', '搜索更多内容', 'valid first', 'VALID FIRST!', 'valid second'],
        peopleAlsoAsk: ['seed', 'valid first', 'valid question'], relatedSearches: ['seed', 'valid related']
    });
    const before = plain(saved);
    const result = plain(context.buildGroupQueries(saved));
    assert.deepEqual(result.queries, ['seed', 'valid first', 'valid question', 'valid related', 'valid second']);
    assert.deepEqual(saved, before);
    assert.deepEqual(plain(context.buildGroupQueries(saved)), result);
});

test('旧缓存重建只改未执行尾部，保留已执行前缀和进度下标', () => {
    const { context } = harness(2);
    const saved = group({ queries: ['seed', '已执行的旧词', '搜索更多内容', 'pending old'],
        searchBoxSuggestions: ['seed', '已执行的旧词', 'history word', 'new suggestion'] });
    const result = plain(context.buildGroupQueries(saved, 2, ['HISTORY WORD!']));
    assert.deepEqual(result.queries, ['seed', '已执行的旧词', 'new suggestion']);
    assert.equal(result.querySources[2], 'suggestion');
    assert.equal(saved.endCount, 5);
});

test('页面采集只接受明确问题和对应查询链接，反馈、隐藏节点和伪造链接被排除', () => {
    const h = harness();
    h.dom.paa = [
        element('answer body', { 'data-question': 'How does it work' }),
        element('question and answer', { role: 'button', 'aria-controls': 'answer', 'aria-expanded': 'false' },
            { label: 'How to collect customer feedback' }),
        element('搜索更多内容', { class: 'b_paaQuestion' }),
        element('do not scrape a generic button', { role: 'button' }),
        element('hidden question', { 'data-question': 'hidden question' }, { hidden: true }),
        element('feedback', { class: 'b_paaQuestion', id: 'b_feedback' })
    ];
    const link = (text, href, attrs = {}, options = {}) => element(text, { href, ...attrs }, options);
    h.dom.related = [
        link('real query', '/search?q=real+query'), link('2026', 'https://cn.bing.com/search?q=2026'),
        link('搜索更多内容', '/search?q=搜索更多内容'), link('feedback', '/search?q=feedback'),
        link('external', 'https://example.org/search?q=external'),
        link('suffix attack', 'https://bing.com.evil.test/search?q=suffix+attack'),
        link('prefix attack', 'https://evilbing.com/search?q=prefix+attack'),
        link('credentials', 'https://user:pass@www.bing.com/search?q=credentials'),
        link('insecure', 'http://www.bing.com/search?q=insecure'),
        link('wrong path', '/more?q=wrong+path'), link('duplicate q', '/search?q=duplicate+q&q=second'),
        link('text does not match', '/search?q=another'),
        link('hidden query', '/search?q=hidden+query', {}, { noRect: true }),
        link('css hidden', '/search?q=css+hidden', {}, { visibility: 'hidden' }),
        link('valid-looking control', '/search?q=valid-looking+control', { id: 'b_see-more' })
    ];
    assert.deepEqual(plain(h.context.collectPageAssociations('seed')), {
        peopleAlsoAsk: ['How does it work', 'How to collect customer feedback'],
        relatedSearches: ['real query', '2026']
    });
    assert.ok(h.selectors.every(selector => !selector.includes('.b_ans') && !selector.includes('.b_vList')));
});

test('URL、搜索框或结果页与首词不符时，不混入其他页面的关联词', () => {
    for (const mutate of [
        h => { h.context.window.location = new URL('https://www.bing.com/search?q=other'); },
        h => { h.context.window.location = new URL('https://www.bing.com/search?q=seed&q=other'); },
        h => { h.dom.input = 'other'; }, h => { h.dom.results = false; }
    ]) {
        const h = harness();
        h.dom.paa = [element('wrong page question', { 'data-question': 'wrong page question' })];
        mutate(h);
        assert.deepEqual(plain(h.context.collectPageAssociations('seed')), { peopleAlsoAsk: [], relatedSearches: [] });
        assert.equal(h.selectors.length, 0);
    }
});

test('PAA 延迟出现后连续两次稳定才采纳，不稳定快照不存入队列', async () => {
    const h = harness();
    let checks = 0;
    h.context.collectPageAssociations = () => {
        checks++;
        return { peopleAlsoAsk: checks === 1 ? [] : ['stable question'], relatedSearches: [] };
    };
    const result = await h.context.enrichSearchGroupFromPage(group({ pageAssociationsCollected: false }), 1);
    assert.equal(checks, 3);
    assert.deepEqual(plain(result.peopleAlsoAsk), ['stable question']);
    checks = 0;
    h.context.collectPageAssociations = () => ({ peopleAlsoAsk: [`changes ${++checks}`], relatedSearches: [] });
    const unstable = await h.context.enrichSearchGroupFromPage(group({ pageAssociationsCollected: false }), 1);
    assert.deepEqual(plain(unstable.peopleAlsoAsk), []);
    assert.equal(checks, 6);
});

test('升级旧缓存重新拉取联想，保留已执行位置、计数和暂停边界', async () => {
    const h = harness(2);
    const old = group({ queries: ['seed', 'old executed', '搜索更多内容'],
        peopleAlsoAsk: ['untrusted old question'], relatedSearches: ['untrusted old related'] });
    delete old.associationVersion;
    delete old.runGeneration;
    delete old.region;
    h.storage.set('active_search_group_us', old);
    const word = await h.context.getGroupedSearchWord({ currentCount: 2, maxCount: 15 }, 1);
    assert.equal(word, 'fresh suggestion');
    const saved = h.storage.get('active_search_group_us');
    assert.deepEqual(saved.queries, ['seed', 'old executed', 'fresh suggestion']);
    assert.deepEqual(saved.peopleAlsoAsk, []);
    assert.deepEqual(saved.relatedSearches, []);
    assert.equal(saved.associationVersion, 1);
    assert.equal(saved.endCount, 5);
    assert.equal(h.storage.get('searchCount'), 2);
    assert.equal(h.storage.get('nextPauseAt'), 5);
    assert.equal(h.state.preparedSearchQuery.source, 'suggestion');
    assert.deepEqual(h.storage.get('associationSearchHistory').queries, ['seed', 'old executed']);
});

test('过滤后联想耗尽立即换新随机热词，不重复首词、不增加计数或改变暂停边界', async () => {
    const h = harness(2);
    h.storage.set('active_search_group_us', group({ queries: ['seed', 'previous query', '搜索更多内容'],
        searchBoxSuggestions: ['seed', 'previous query', 'tell us more'], peopleAlsoAsk: ['搜索更多内容'] }));
    h.state.searchWords = ['seed', 'previous query', 'new topic'];
    assert.equal(await h.context.getGroupedSearchWord({ currentCount: 2, maxCount: 15 }, 1), 'new topic');
    const saved = h.storage.get('active_search_group_us');
    assert.equal(saved.startCount, 2);
    assert.equal(saved.endCount, 5);
    assert.deepEqual(saved.queries, ['new topic']);
    assert.equal(h.storage.get('searchCount'), 2);
    assert.equal(h.storage.get('nextPauseAt'), 5);
});

test('已确认搜索历史跨词组去重，耗尽所有首词则有限返回，不递归重复', async () => {
    const h = harness(5);
    h.storage.set('associationSearchHistory', { date: '2026-10-10', region: 'us', runGeneration: 1,
        queries: ['NEW TOPIC!', 'fallback topic'] });
    assert.equal(await h.context.getGroupedSearchWord({ currentCount: 5, maxCount: 15 }, 1), '');
    assert.equal(h.storage.has('active_search_group_us'), false);
    assert.equal(h.state.preparedSearchQuery, null);
});

test('热词原文保留，最后一组不超过总搜索数；实际搜索不再使用加词截词函数', async () => {
    const h = harness(4);
    h.state.searchWords = ['完整  热词！'];
    assert.equal(await h.context.getGroupedSearchWord({ currentCount: 4, maxCount: 5 }, 1), '完整  热词！');
    assert.equal(h.storage.get('active_search_group_us').endCount, 5);
    assert.equal(h.context.isPreparedSearchQueryValid('完整  热词！', { currentCount: 4 }, 1,
        h.state.preparedSearchQuery), true);
    assert.doesNotMatch(functionSource('executeSearch'), /processSearchWord|randomAddSearchWords|randomCutSearchWords/);
});

test('异步联想返回后核对终止、代际、地区、日期、计数，不写回旧任务缓存', async () => {
    const mutations = [
        h => { h.state.isRunning = false; },
        h => h.storage.set('searchRunGeneration', 2),
        h => { h.context.getExecutionRegion = () => 'hk'; },
        h => { h.context.utils.getTodayStr = () => '2026-10-11'; },
        h => h.storage.set('searchCount', 1)
    ];
    for (const mutate of mutations) {
        const h = harness(0);
        let complete;
        h.context.GM_xmlhttpRequest = options => { complete = options.onload; };
        const pending = h.context.getGroupedSearchWord({ currentCount: 0, maxCount: 15 }, 1);
        assert.equal(typeof complete, 'function');
        mutate(h);
        complete({ responseText: JSON.stringify(['seed', ['fresh suggestion']]) });
        assert.equal(await pending, '');
        assert.equal(h.storage.has('active_search_group_us'), false);
        assert.equal(h.state.preparedSearchQuery, null);
    }
});

test('旧缓存升级请求和延迟 DOM 采集遇到终止重启，不覆盖新任务数据', async () => {
    for (const legacy of [true, false]) {
        const h = harness();
        const saved = group({ pageAssociationsCollected: false });
        if (legacy) delete saved.associationVersion;
        h.storage.set('active_search_group_us', saved);
        let resume;
        h.context.GM_xmlhttpRequest = options => { resume = () => options.onload({ responseText: '[]' }); };
        h.context.setTimeout = callback => { resume = callback; };
        const pending = h.context.getGroupedSearchWord({ currentCount: 1, maxCount: 15 }, 1);
        assert.equal(typeof resume, 'function');
        h.storage.set('searchRunGeneration', 2);
        const replacement = { newRun: true };
        h.storage.set('active_search_group_us', replacement);
        const newPrepared = { newRun: true };
        h.state.preparedSearchQuery = newPrepared;
        resume();
        assert.equal(await pending, '');
        assert.deepEqual(h.storage.get('active_search_group_us'), replacement);
        assert.equal(h.state.preparedSearchQuery, newPrepared);
    }
});

test('旧任务入口不清空新任务已经准备的关键词', async () => {
    const h = harness(0);
    h.storage.set('searchRunGeneration', 2);
    const prepared = { runGeneration: 2, word: 'new task query' };
    h.state.preparedSearchQuery = prepared;
    assert.equal(await h.context.getGroupedSearchWord({ currentCount: 0, maxCount: 15 }, 1), '');
    assert.equal(h.state.preparedSearchQuery, prepared);
});
