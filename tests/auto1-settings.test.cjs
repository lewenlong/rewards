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

function renderSettings(clickSearchResults, presetId = 'android-16-xiaomi15') {
    const storage = new Map([
        ['customClickSearchResults', clickSearchResults],
        ['customAppUaPreset', presetId],
        ['customRandomAddSearchWords', true], ['customRandomAddSearchWordsFactor', 2],
        ['customRandomCutSearchWords', true], ['customRandomCutSearchWordsFactor', 2]
    ]);
    const context = vm.createContext({
        Date, Math, console: { log() {} },
        GM_info: { script: { version: '26.10.10.3' } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        document: { getElementById: () => null, createElement: () => ({ innerHTML: '' }) },
        EXECUTION_REGIONS: { cn: { label: '中国大陆', language: 'zh-CN' } },
        utils: { escapeHtml: text => String(text) }
    });
    vm.runInContext(configSource + '\n' + presetsSource + '\n' + source.slice(settingsStart, renderEnd) +
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
