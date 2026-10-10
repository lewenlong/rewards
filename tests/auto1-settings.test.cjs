const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'auto1.user.js'), 'utf8').replace(/\r\n/g, '\n');
const settingsStart = source.indexOf('function showSettingsDialog(theme)');
const renderEnd = source.indexOf('\n    document.body.appendChild(dialog);', settingsStart);
assert.ok(settingsStart >= 0 && renderEnd > settingsStart);
const configSource = source.slice(source.indexOf('const CONFIG_SCHEMA'), source.indexOf('// 状态管理'));
const presetsSource = source.slice(source.indexOf('// APP 设备预设：'), source.indexOf('\nfunction getAccountProfileUrl'));
assert.ok(presetsSource.includes('function buildAppPresetOptions'));

function renderSettings(clickSearchResults, presetId = 'android-16-xiaomi15', savedValues = {}) {
    const storage = new Map([
        ['customAppUaPreset', presetId],
        ['customRandomAddSearchWords', true], ['customRandomAddSearchWordsFactor', 2],
        ['customRandomCutSearchWords', true], ['customRandomCutSearchWordsFactor', 2]
    ]);
    if (clickSearchResults !== undefined) storage.set('customClickSearchResults', clickSearchResults);
    for (const [key, value] of Object.entries(savedValues)) storage.set(key, value);
    const context = vm.createContext({
        Date, Math, console: { log() {} },
        GM_info: { script: { version: '26.10.10.4' } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        document: { getElementById: () => null, createElement: () => ({ innerHTML: '' }) },
        EXECUTION_REGIONS: { cn: { label: '中国大陆', language: 'zh-CN' } },
        utils: { escapeHtml: text => String(text) }
    });
    vm.runInContext(configSource + '\n' + presetsSource + '\n' + source.slice(settingsStart, renderEnd) +
        '\nreturn dialog.innerHTML;\n}\n' +
        'globalThis.html = showSettingsDialog({}); globalThis.schema = CONFIG_SCHEMA; globalThis.config = CONFIG;', context);
    return { html: context.html, schema: context.schema, config: context.config, storage, context };
}

const requestedDefaults = {
    clickSearchResults: true, pauseTimeMin: 5 * 60000, pauseTimeMax: 20 * 60000,
    autoClickTasks: true, appCheckInEnabled: true, appReadEnabled: true,
    appReadDailyLimitMin: 7, appReadDailyLimitMax: 15
};
const defaultControls = {
    clickSearchResults: ['click-search-results-checkbox', 'clickSearchResultsCheckbox', 'checked'],
    pauseTimeMin: ['pause-time-min-input', 'pauseTimeMinInput', 'value', 60000],
    pauseTimeMax: ['pause-time-max-input', 'pauseTimeMaxInput', 'value', 60000],
    autoClickTasks: ['auto-click-tasks-checkbox', 'autoClickTasksCheckbox', 'checked'],
    appCheckInEnabled: ['app-checkin-checkbox', 'appCheckInCheckbox', 'checked'],
    appReadEnabled: ['app-read-checkbox', 'appReadCheckbox', 'checked'],
    appReadDailyLimitMin: ['app-read-limit-min-input', 'appReadLimitMinInput', 'value'],
    appReadDailyLimitMax: ['app-read-limit-max-input', 'appReadLimitMaxInput', 'value']
};

function assertFormValues(html, values) {
    for (const [name, expected] of Object.entries(values)) {
        const [id, , property, scale = 1] = defaultControls[name];
        const input = html.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(input, `Missing control: ${id}`);
        if (property === 'checked') assert.equal(/\bchecked\b/.test(input), expected, name);
        else assert.equal(Number(input.match(/\bvalue="([^"]*)"/)[1]), expected / scale, name);
    }
}

test('未保存配置时使用新默认值，设置页与运行配置一致且不写入存储', () => {
    const { html, schema, config, storage } = renderSettings();
    for (const [name, expected] of Object.entries(requestedDefaults)) {
        assert.equal(schema[name].default, expected, name);
        assert.equal(config[name], expected, name);
        assert.equal(storage.has(schema[name].key), false, name);
    }
    assertFormValues(html, requestedDefaults);
    assert.match(html, /5-20分钟/);
    assert.match(html, /默认区间为 7-15 篇/);
    assert.match(html, /每次搜索组间暂停随机上报 1-3 篇/);
});

test('新默认值不会覆盖旧用户保存的关闭状态、暂停时长和阅读区间', () => {
    const savedValues = {
        customClickSearchResults: false, customPauseTimeMin: 20 * 60000, customPauseTimeMax: 30 * 60000,
        customAutoClickTasks: false, customAppCheckInEnabled: false, customAppReadEnabled: false,
        customAppReadDailyLimitMin: 5, customAppReadDailyLimitMax: 10
    };
    const { html, schema, config, storage } = renderSettings(undefined, undefined, savedValues);
    const expected = {};
    for (const name of Object.keys(requestedDefaults)) {
        expected[name] = savedValues[schema[name].key];
        assert.equal(config[name], expected[name], name);
        assert.equal(storage.get(schema[name].key), expected[name], name);
    }
    assertFormValues(html, expected);
});

test('恢复默认同步新值并更新开关样式，仅修改表单、不提前保存', () => {
    const { context, storage, schema } = renderSettings(false);
    const before = [...storage];
    const changes = [];
    const otherControls = ['executionRegionInput', 'minSearchesInput', 'maxSearchesInput',
        'pauseIntervalMinInput', 'pauseIntervalMaxInput', 'minDelayInput', 'maxDelayInput',
        'tasksScrollDelayInput', 'tasksMaxRetriesInput', 'tasksRetryDelayInput',
        'tasksCloseTabDelayInput', 'appUaPresetSelect'];
    for (const name of [...otherControls, ...Object.values(defaultControls).map(control => control[1])]) {
        context[name] = { value: '', checked: false,
            dispatchEvent(event) { changes.push([name, event.type, this.checked]); } };
    }
    context.panelStateRadios = ['expanded', 'collapsed'].map(value => ({
        value, checked: false, dispatchEvent() {}
    }));
    context.Event = class { constructor(type) { this.type = type; } };
    context.renderAppUaPreset = () => {};
    context.showSettingsMessage = message => { context.message = message; };
    const start = source.indexOf('    const restoreDefaultFormValues = () => {');
    const end = source.indexOf('\n    // 恢复默认按钮', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end) + '\nrestoreDefaultFormValues();', context);
    for (const [name, [, variable, property, scale = 1]] of Object.entries(defaultControls)) {
        const expected = property === 'checked' ? schema[name].default : schema[name].default / scale;
        assert.equal(context[variable][property], expected, name);
    }
    assert.equal(changes.length, 4);
    assert.ok(changes.every(([, event, checked]) => event === 'change' && checked === true));
    assert.deepEqual([...storage], before);
    assert.match(context.message, /请点击“保存配置”以应用/);
});

test('结果页浏览也默认开启，同时尊重用户显式关闭的配置', () => {
    const start = source.indexOf('function runSearchResultReader(token) {');
    const end = source.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start);
    for (const enabled of [undefined, false]) {
        let tick;
        let now = 1000;
        const job = { url: 'https://example.test/article', status: 'pending',
            expiresAt: 50000, duration: 10000, runGeneration: 1 };
        const storage = new Map([['search_result_read_test', job], ['searchRunGeneration', 1]]);
        if (enabled !== undefined) storage.set('customClickSearchResults', enabled);
        const scrolls = [];
        const context = vm.createContext({
            URL, Date: class extends Date { static now() { return now; } },
            window: {
                location: new URL(job.url), history: { state: null, replaceState() {} }, scrollY: 0,
                addEventListener() {}, removeEventListener() {},
                getSelection: () => ({ isCollapsed: true }),
                scrollTo: options => scrolls.push(options)
            },
            document: { hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {} },
            GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
            GM_setValue: (key, value) => storage.set(key, value),
            GM_registerMenuCommand() {},
            setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
            getResultReadingStep: () => ({ top: 300, dwell: 2200 })
        });
        vm.runInContext(source.slice(start, end) + '\nrunSearchResultReader("test");', context);
        now = 4000;
        tick();
        assert.equal(scrolls.length, enabled === false ? 0 : 1);
        assert.equal(storage.get('search_result_read_test').status, enabled === false ? 'finished' : 'reading');
    }
});

test('设置页删除搜索行为优化及所有加词/截词选项和引用', () => {
    const { html, schema } = renderSettings(false);
    assert.doesNotMatch(html, /搜索行为优化|random-add|random-cut|随机加词|随机截词/);
    assert.doesNotMatch(source, /randomAdd|randomCut|random-add|random-cut|addRandomCharsToSearchWord|cutSearchWordRandomly|processSearchWord/);
    for (const key of ['randomAddSearchWords', 'randomAddSearchWordsFactor',
        'randomCutSearchWords', 'randomCutSearchWordsFactor']) {
        assert.equal(Object.hasOwn(schema, key), false);
    }
});

test('自动打开搜索结果仅保留一个开关，位于基础配置，HTML 标签保持配对', () => {
    const { html } = renderSettings(false);
    const stack = [];
    const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
    let found = 0;
    const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const match of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
        const [, closing, rawTag, attrs] = match;
        const tag = rawTag.toLowerCase();
        if (closing) {
            assert.equal(stack.pop()?.tag, tag, `Unbalanced closing tag: ${match[0]}`);
        } else {
            if (tag === 'input' && /id="click-search-results-checkbox"/.test(attrs)) {
                found++;
                const section = [...stack].reverse().find(node => /data-section=/.test(node.attrs));
                assert.match(section.attrs, /data-section="基础配置"/);
            }
            if (!voidTags.has(tag) && !/\/$/.test(attrs)) stack.push({ tag, attrs });
        }
    }
    assert.equal(found, 1);
    assert.equal(stack.length, 0);
});

test('保留搜索结果开关的原存储键和状态，不删除已有用户配置', () => {
    for (const enabled of [false, true]) {
        const { html, schema, storage } = renderSettings(enabled);
        const input = html.match(/<input\b[^>]*id="click-search-results-checkbox"[^>]*>/)[0];
        assert.equal(/\bchecked\b/.test(input), enabled);
        assert.equal(schema.clickSearchResults.key, 'customClickSearchResults');
        assert.equal(schema.clickSearchResults.default, true);
        assert.equal(storage.get('customClickSearchResults'), enabled);
        assert.equal(storage.get('customRandomAddSearchWords'), true);
    }
});

test('设备下拉框按 Android/iOS 分组，显示全部 14 项并保留旧、新选择', () => {
    for (const selectedId of ['android-16-xiaomi15', 'android-15-pixel9', 'android-14-galaxy-s24',
        'ios-18-iphone16', 'android-14-oppo-findx7', 'ios-17-iphone']) {
        const { html, storage } = renderSettings(false, selectedId);
        const select = html.match(/<select\b[^>]*id="app-ua-preset-select"[^>]*>([\s\S]*?)<\/select>/)[1];
        assert.equal([...select.matchAll(/<option\b/g)].length, 14);
        assert.match(select, /<optgroup label="Android">/);
        assert.match(select, /<optgroup label="iOS">/);
        assert.equal([...select.matchAll(/\bselected\b/g)].length, 1);
        assert.match(select, new RegExp(`value="${selectedId}" selected`));
        assert.equal([...select.matchAll(/（兼容模板）/g)].length, 10);
        assert.equal(storage.get('customAppUaPreset'), selectedId);
    }
});

test('无效设备配置在设置页也回退到现有默认设备', () => {
    const { html } = renderSettings(false, 'invalid-preset');
    assert.match(html, /value="android-16-xiaomi15" selected/);
});
