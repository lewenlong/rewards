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

function renderSettings(clickSearchResults) {
    const storage = new Map([
        ['customClickSearchResults', clickSearchResults],
        ['customRandomAddSearchWords', true], ['customRandomAddSearchWordsFactor', 2],
        ['customRandomCutSearchWords', true], ['customRandomCutSearchWordsFactor', 2]
    ]);
    const context = vm.createContext({
        Date, Math, console: { log() {} },
        GM_info: { script: { version: '26.10.10.2' } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        document: { getElementById: () => null, createElement: () => ({ innerHTML: '' }) },
        EXECUTION_REGIONS: { cn: { label: '中国大陆', language: 'zh-CN' } },
        APP_CLIENT_DEFAULT_PRESET: 'android-16-xiaomi15',
        APP_CLIENT_PRESETS: [{ id: 'android-16-xiaomi15', name: 'test device', label: 'test device',
            channel: 'test', version: '1', userAgent: 'test agent' }],
        utils: { escapeHtml: text => String(text) }
    });
    vm.runInContext(configSource + '\n' + source.slice(settingsStart, renderEnd) +
        '\nreturn dialog.innerHTML;\n}\n' +
        'globalThis.html = showSettingsDialog({}); globalThis.schema = CONFIG_SCHEMA;', context);
    return { html: context.html, schema: context.schema, storage };
}

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
        assert.equal(schema.clickSearchResults.default, false);
        assert.equal(storage.get('customClickSearchResults'), enabled);
        assert.equal(storage.get('customRandomAddSearchWords'), true);
    }
});
