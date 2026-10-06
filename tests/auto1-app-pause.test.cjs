const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'auto1.user.js'), 'utf8').replace(/\r\n/g, '\n');
const runnerStart = source.indexOf('const AppTaskRunner = {');
const runnerEnd = source.indexOf('\n// 工具函数', runnerStart);
assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);

function functionSource(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, `Missing function: ${name}`);
    return source.slice(match.index, source.indexOf('\n}\n', match.index) + 3);
}

function readingHarness(target = 4) {
    const today = 20261006;
    let now = 1000;
    let reports = 0;
    const storage = new Map([
        ['appReadLimitDate', today], ['appReadDailyTarget', target],
        ['appReadReportedDate', today], ['appReadReportedCount', 0]
    ]);
    const state = {
        isRunning: true, appToken: 'test-token',
        appTasks: { readRunning: false, readProgressSynced: true, readCurrent: 30, readTotal: 30, readDone: false }
    };
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        Math,
        setTimeout: callback => callback(),
        CONFIG: { appReadEnabled: true, appReadDailyLimitMin: target, appReadDailyLimitMax: target },
        state,
        AppAuth: { ensureToken: async () => true },
        AppApi: { reportArticleRead: async () => { reports++; return { points: 0, duplicate: false }; } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        GM_log() {}, createStatusPanel() {}, updateStatusPanel() {},
        isCurrentSearchRun: generation => state.isRunning && generation === 1
    });
    vm.runInContext(source.slice(runnerStart, runnerEnd) + '\nglobalThis.AppTaskRunner = AppTaskRunner;', context);
    context.AppTaskRunner.getTodayNum = () => today;
    return { context, storage, state, today, setNow: value => { now = value; }, getReports: () => reports };
}

test('auto1 在组间暂停期间上报当天剩余阅读篇数', async () => {
    const h = readingHarness(4);
    await h.context.AppTaskRunner.runReadsDuringPause(1, 60000);
    assert.equal(h.getReports(), 4);
    assert.equal(h.storage.get('appReadReportedCount'), 4);
    assert.equal(h.storage.get('appReadDate'), h.today);
    assert.equal(h.state.appTasks.readRunning, false);
});

test('暂停截止时当前阅读可记账，但不再发起下一篇', async () => {
    const h = readingHarness(4);
    h.context.AppApi.reportArticleRead = async () => {
        h.setNow(2000);
        return { points: 0, duplicate: false };
    };
    await h.context.AppTaskRunner.runReadsDuringPause(1, 1500);
    assert.equal(h.storage.get('appReadReportedCount'), 1);
    assert.equal(h.storage.has('appReadDate'), false);
});

test('恢复页面时暂停已过期，不再启动 APP 阅读', async () => {
    const h = readingHarness(4);
    await h.context.AppTaskRunner.runReadsDuringPause(1, 1000);
    assert.equal(h.getReports(), 0);
    assert.equal(h.storage.get('appReadReportedCount'), 0);
});

test('暂停中终止任务后，进行中的请求结束也不再发起下一篇', async () => {
    const h = readingHarness(4);
    let requestStarted;
    let finishRequest;
    const started = new Promise(resolve => { requestStarted = resolve; });
    h.context.AppApi.reportArticleRead = () => {
        requestStarted();
        return new Promise(resolve => { finishRequest = resolve; });
    };
    const reading = h.context.AppTaskRunner.runReadsDuringPause(1, 60000);
    await started;
    h.state.isRunning = false;
    finishRequest({ points: 0, duplicate: false });
    await reading;
    assert.equal(h.storage.get('appReadReportedCount'), 1);
    assert.equal(h.state.appTasks.readRunning, false);
});

test('暂停倒计时和阅读并行，到点等待当前阅读收尾才继续搜索', async () => {
    let finishPause;
    let finishReading;
    const calls = [];
    const context = vm.createContext({
        Date: class extends Date { static now() { return 1000; } },
        GM_getValue: () => ({ runGeneration: 1, resumeAt: 2000 }),
        waitForSearchPause: () => new Promise(resolve => { finishPause = resolve; }),
        AppTaskRunner: { runReadsDuringPause: (generation, deadline) => {
            calls.push([generation, deadline]);
            return new Promise(resolve => { finishReading = resolve; });
        } },
        GM_log() {}, isCurrentSearchRun: () => true
    });
    vm.runInContext(functionSource('waitForSearchPauseWithReads') +
        '\nglobalThis.waitForSearchPauseWithReads = waitForSearchPauseWithReads;', context);
    const pending = context.waitForSearchPauseWithReads(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 2000);
    finishPause(true);
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    finishReading();
    assert.equal(await pending, true);
});

test('暂停被取消时不等待阅读完成，也不推进搜索', async () => {
    let finishPause;
    const context = vm.createContext({
        Date: class extends Date { static now() { return 1000; } },
        GM_getValue: () => ({ runGeneration: 1, resumeAt: 2000 }),
        waitForSearchPause: () => new Promise(resolve => { finishPause = resolve; }),
        AppTaskRunner: { runReadsDuringPause: () => new Promise(() => {}) },
        GM_log() {}, isCurrentSearchRun: () => false
    });
    vm.runInContext(functionSource('waitForSearchPauseWithReads') +
        '\nglobalThis.waitForSearchPauseWithReads = waitForSearchPauseWithReads;', context);
    const pending = context.waitForSearchPauseWithReads(1);
    finishPause(false);
    assert.equal(await pending, false);
});
