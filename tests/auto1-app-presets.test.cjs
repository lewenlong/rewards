const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'auto1.user.js'), 'utf8').replace(/\r\n/g, '\n');
const configSource = source.slice(source.indexOf('const CONFIG_SCHEMA'), source.indexOf('// 状态管理'));
const presetsSource = source.slice(source.indexOf('// APP 设备预设：'), source.indexOf('\n/**\n * APP 端网络请求封装'));
const apiStart = source.indexOf('const AppApi = {');
const apiSource = source.slice(apiStart, source.indexOf('\n};', apiStart) + 4);
assert.ok(presetsSource.includes('function getAccountProfileUrl'));
assert.ok(apiSource.includes('buildHeaders(extra)'));

function harness() {
    const storage = new Map();
    const context = vm.createContext({
        URL, Date, Math,
        GM_info: { script: { version: '26.10.10.3' } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        getExecutionRegion: () => 'us', EXECUTION_REGIONS: { us: { appLanguage: 'en-US' } },
        REWARDS_APP_SPEC: { endpoints: { accountProfile: 'https://prod.rewardsplatform.microsoft.com/dapi/me' } },
        utils: { escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char])) }
    });
    vm.runInContext(configSource + '\n' + presetsSource + '\n' + apiSource +
        '\nglobalThis.presets = APP_CLIENT_PRESETS; globalThis.defaultPreset = APP_CLIENT_DEFAULT_PRESET;' +
        '\nglobalThis.schema = CONFIG_SCHEMA; globalThis.api = AppApi;', context);
    return { context, storage };
}

test('增加 10 项模板，总计 14 项，ID 和 UA 均唯一，平台及 APP 版本一致', () => {
    const { context } = harness();
    const presets = Array.from(context.presets);
    assert.equal(presets.length, 14);
    assert.equal(new Set(presets.map(preset => preset.id)).size, 14);
    assert.equal(new Set(presets.map(preset => preset.userAgent)).size, 14);
    assert.equal(presets.filter(preset => preset.kind === 'template').length, 10);
    assert.equal(presets.filter(preset => preset.channel === 'SAAndroid').length, 11);
    assert.equal(presets.filter(preset => preset.channel === 'SAIOS').length, 3);
    for (const preset of presets) {
        assert.ok(preset.label);
        assert.match(preset.userAgent, /^Mozilla\/5\.0 /);
        assert.ok(preset.userAgent.endsWith(`BingSapphire/${preset.version}`));
        assert.doesNotMatch(preset.userAgent, /[\r\n]|undefined|null/);
        assert.equal(preset.channel, preset.id.startsWith('ios-') ? 'SAIOS' : 'SAAndroid');
        if (preset.kind === 'template') {
            assert.doesNotMatch(preset.userAgent, /Build\//);
            assert.equal(Object.hasOwn(preset, 'capturedAt'), false);
            assert.equal(Object.hasOwn(preset, 'sourceUrl'), false);
        }
    }
});

test('原有 4 个设备、完整 UA、版本和默认设备均保持不变', () => {
    const { context } = harness();
    const expected = [
        ['android-16-xiaomi15', 'SAAndroid', 'Mozilla/5.0 (Linux; Android 16; Xiaomi 15 Pro Build/BP1A.250605.012; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'],
        ['android-15-pixel9', 'SAAndroid', 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250105.002; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'],
        ['android-14-galaxy-s24', 'SAAndroid', 'Mozilla/5.0 (Linux; Android 14; SM-S9210 Build/UP1A.231005.007; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'],
        ['ios-18-iphone16', 'SAIOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 BingSapphire/32.6.2110003560']
    ];
    expected.forEach(([id, channel, userAgent], index) => {
        assert.equal(context.presets[index].id, id);
        assert.equal(context.presets[index].channel, channel);
        assert.equal(context.presets[index].userAgent, userAgent);
        assert.equal(context.presets[index].version, '32.6.2110003560');
    });
    assert.equal(context.defaultPreset, 'android-16-xiaomi15');
    assert.equal(context.schema.appUaPreset.default, 'android-16-xiaomi15');
    assert.equal(context.getAppClient().presetId, 'android-16-xiaomi15');
});

test('每个预设的请求 UA、APP ID 和账户接口 channel 同步，不自动轮换或改地区', () => {
    const { context, storage } = harness();
    for (const preset of context.presets) {
        storage.set('customAppUaPreset', preset.id);
        for (let repeat = 0; repeat < 3; repeat++) {
            const client = context.getAppClient();
            const headers = context.api.buildHeaders({ 'test-header': 'test' });
            const profile = new URL(context.getAccountProfileUrl());
            assert.equal(client.presetId, preset.id);
            assert.equal(client.appId, `${preset.channel}/${preset.version}`);
            assert.equal(headers['user-agent'], preset.userAgent);
            assert.equal(headers['x-rewards-appid'], client.appId);
            assert.equal(headers['x-rewards-country'], 'us');
            assert.equal(headers['x-rewards-language'], 'en-US');
            assert.equal(headers['test-header'], 'test');
            assert.equal(profile.searchParams.get('channel'), preset.channel);
            assert.equal(profile.searchParams.get('options'), '613');
            assert.equal(storage.get('customAppUaPreset'), preset.id);
        }
    }
});

test('无效或已不存在的预设统一回退现有默认设备', () => {
    const { context, storage } = harness();
    for (const invalid of ['', 'unknown-preset', null]) {
        storage.set('customAppUaPreset', invalid);
        assert.equal(context.getAppClient().presetId, 'android-16-xiaomi15');
        const options = context.buildAppPresetOptions(invalid);
        assert.equal([...options.matchAll(/\bselected\b/g)].length, 1);
        assert.match(options, /value="android-16-xiaomi15" selected/);
    }
});

test('新增模板和已有预设均提示来源状态，不把标签当成真机验证', () => {
    const { context } = harness();
    for (const preset of context.presets) {
        const notice = context.getAppPresetNotice(preset);
        assert.match(notice, /仅设置请求头，不代表真实机型或设备环境/);
        assert.match(notice, preset.kind === 'template' ? /非真机采集/ : /来源未经验证/);
    }
    for (const selected of context.presets) {
        const options = context.buildAppPresetOptions(selected.id);
        assert.equal([...options.matchAll(/<option\b/g)].length, 14);
        assert.equal([...options.matchAll(/\bselected\b/g)].length, 1);
        assert.match(options, new RegExp(`value="${selected.id}" selected`));
    }
});
