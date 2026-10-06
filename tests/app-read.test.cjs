const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', process.env.REWARDS_SCRIPT_FILE || 'auto.user.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('const AppApi = {');
const end = source.indexOf('\n// 工具函数', start);
assert.ok(start >= 0 && end > start, 'APP API 与任务流程源码必须存在');

function functionSource(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, `Missing function: ${name}`);
    return source.slice(match.index, source.indexOf('\n}\n', match.index) + 3);
}

function harness(initialResponse) {
    const today = 20261005;
    const storage = new Map([
        ['appReadLimitDate', today],
        ['appReadDailyTarget', 14],
        ['appReadReportedDate', today],
        ['appReadReportedCount', 10]
    ]);
    const logs = [];
    const state = {
        appTasks: { readCurrent: 30, readTotal: 30, readDone: false, checkInDone: false },
        panel: { currentWord: '', pauseTimeLeft: null }, isRunning: true
    };
    let response = initialResponse;
    const context = vm.createContext({
        window: { crypto: null },
        Math,
        setTimeout: callback => callback(),
        getExecutionRegion: () => 'us',
        EXECUTION_REGIONS: { us: { appLanguage: 'en' } },
        getAppClient: () => ({ userAgent: 'test', appId: 'test', channel: 'test' }),
        REWARDS_APP_SPEC: {
            endpoints: { activityReport: 'https://example.test/activity' },
            activities: { checkIn: 103, readArticle: 101 },
            offers: { readArticle: 'test-read-offer' }
        },
        AppAuth: { withAuth: async callback => callback('test-token') },
        request: async () => JSON.stringify(response),
        utils: { safeJsonParse: (value, fallback) => {
            try { return JSON.parse(value); } catch { return fallback; }
        }, getAccurateRemainingTime: () => 0 },
        GM_log: message => logs.push(message),
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        GM_deleteValue: key => storage.delete(key),
        CONFIG: { appCheckInEnabled: true, appReadEnabled: true },
        state,
        isTaskTerminatedToday: () => false,
        isCurrentSearchRun: () => state.isRunning,
        updateStatusPanel() {}
    });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.AppApi = AppApi; globalThis.AppTaskRunner = AppTaskRunner;', context);
    context.AppTaskRunner.getTodayNum = () => today;
    return { context, storage, state, logs, today, setResponse: value => { response = value; } };
}

test('零积分但有明确活动记录且非重复，仍算一次阅读', async () => {
    const h = harness({ response: { activity: { p: 0 }, isDuplicate: false, balance: 30 } });
    const result = await h.context.AppApi.reportArticleRead();
    assert.equal(result.points, 0);
    assert.equal(result.duplicate, false);
    assert.equal(result.hasActivityRecord, true);
    assert.ok(h.logs.some(message => message.includes('积分=0') && message.includes('有活动记录=true')));
    assert.ok(h.logs.every(message => !message.includes('test-token')));
});

test('从 10 篇继续上报到随机目标 14 篇，零积分不虚增服务端积分进度', async () => {
    const h = harness({ response: { activity: { p: 0 }, isDuplicate: false, balance: 30 } });
    await h.context.AppTaskRunner.reportReadBatch(4, false);
    assert.equal(h.storage.get('appReadReportedCount'), 14);
    assert.equal(h.storage.get('appReadDate'), h.today);
    assert.equal(h.state.appTasks.readDone, true);
    assert.equal(h.state.appTasks.readCurrent, 30);
});

test('重复或缺少活动记录的零积分响应均不计数', async () => {
    const duplicate = harness({ response: { activity: { p: 0 }, isDuplicate: true, balance: 30 } });
    await duplicate.context.AppTaskRunner.reportReadBatch(4, false);
    assert.equal(duplicate.storage.get('appReadReportedCount'), 10);
    assert.equal(duplicate.storage.has('appReadDate'), false);

    const missing = harness({ response: { activity: null, isDuplicate: false, balance: 30 } });
    assert.equal(await missing.context.AppApi.reportArticleRead(), null);
    await missing.context.AppTaskRunner.reportReadBatch(4, false);
    assert.equal(missing.storage.get('appReadReportedCount'), 10);
    assert.equal(missing.storage.has('appReadDate'), false);
});

test('签到空活动响应不再误判成功，明确重复或活动记录才确认', async () => {
    const h = harness({ response: { activity: null, isDuplicate: false } });
    h.storage.set('appCheckInDate', h.today); // 旧版可能留下的错误完成标记
    h.context.AppTaskRunner.syncCheckInState();
    assert.equal(h.state.appTasks.checkInDone, false);
    assert.equal(h.context.AppTaskRunner.isAllDone(), false);
    await h.context.AppTaskRunner.runCheckIn();
    assert.equal(h.storage.has('appCheckInVerifiedDate'), false);
    assert.equal(h.storage.get('appTaskRetryCounters').checkIn, 1);

    h.setResponse({ response: { activity: null, isDuplicate: true } });
    await h.context.AppTaskRunner.runCheckIn();
    assert.equal(h.storage.get('appCheckInVerifiedDate'), h.today);
    assert.equal(h.state.appTasks.checkInDone, true);
});

test('有明确零积分活动记录的签到仍可确认', async () => {
    const h = harness({ response: { activity: { p: 0 }, isDuplicate: false } });
    await h.context.AppTaskRunner.runCheckIn();
    assert.equal(h.storage.get('appCheckInDate'), h.today);
    assert.equal(h.storage.get('appCheckInVerifiedDate'), h.today);
});

test('升级后重置旧版当日失败计数，之后仍遵守每日两次上限', () => {
    const h = harness({ response: { activity: null } });
    h.storage.set('appTaskRetryDate', h.today);
    h.storage.set('appTaskRetryCounters', { checkIn: 2 });
    assert.equal(h.context.AppTaskRunner.retryLeft('checkIn'), true);
    h.context.AppTaskRunner.bumpRetry('checkIn');
    assert.equal(h.storage.get('appTaskRetryCounters').checkIn, 1);
    h.context.AppTaskRunner.bumpRetry('checkIn');
    assert.equal(h.context.AppTaskRunner.retryLeft('checkIn'), false);
});

test('搜索结束后的 APP 补跑最多两轮，完成后不再请求', async () => {
    const h = harness({ response: { activity: null, isDuplicate: false } });
    let attempts = 0;
    h.context.AppTaskRunner.runAll = async () => { attempts++; };
    await h.context.AppTaskRunner.finishPendingAfterSearch(1);
    assert.equal(attempts, 2);

    h.context.AppTaskRunner.runAll = async () => {
        attempts++;
        h.storage.set('appCheckInDate', h.today);
        h.storage.set('appCheckInVerifiedDate', h.today);
        h.storage.set('appReadDate', h.today);
    };
    await h.context.AppTaskRunner.finishPendingAfterSearch(1);
    assert.equal(attempts, 3);
    assert.equal(h.context.AppTaskRunner.isAllDone(), true);
});

test('搜索达标但 APP 未完成时，面板不显示今日全部完成', () => {
    const h = harness({ response: { activity: null } });
    vm.runInContext([
        functionSource('getAppPendingNotice'), functionSource('derivePanelStatus'),
        'globalThis.getAppPendingNotice = getAppPendingNotice;',
        'globalThis.derivePanelStatus = derivePanelStatus;'
    ].join('\n'), h.context);
    const pending = h.context.derivePanelStatus({ isCompleted: true });
    assert.equal(pending.appPending, true);
    assert.equal(pending.completed, false);
    assert.match(h.context.getAppPendingNotice(), /签到、阅读/);

    h.storage.set('appCheckInDate', h.today);
    h.storage.set('appCheckInVerifiedDate', h.today);
    h.storage.set('appReadDate', h.today);
    const completed = h.context.derivePanelStatus({ isCompleted: true });
    assert.equal(completed.appPending, false);
    assert.equal(completed.completed, true);
});

test('搜索结束后 APP 仍未完成时，通知不会宣称全部任务完成', async () => {
    const h = harness({ response: { activity: null } });
    h.storage.set('searchRunGeneration', 1);
    const notices = [];
    let attempts = 0;
    Object.assign(h.context, {
        createStatusPanel() {},
        getTaskStatus: () => ({ isCompleted: true }),
        openSearchResult: async () => {},
        closeOpenedSearchResultTabs() {},
        resetPanelStatus() {},
        GM_notification: notice => notices.push(notice)
    });
    h.context.AppTaskRunner.finishPendingAfterSearch = async () => { attempts++; };
    h.state.isRunning = false;
    vm.runInContext([
        functionSource('getAppPendingNotice'), functionSource('executeSearch'),
        'globalThis.executeSearch = executeSearch;'
    ].join('\n'), h.context);
    await h.context.executeSearch(1);
    assert.equal(attempts, 1);
    assert.equal(h.state.isRunning, false);
    assert.equal(notices[0].title, 'APP任务未完成');
    assert.match(notices[0].text, /签到、阅读/);
});
