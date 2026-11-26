function createUpdateBridge({request, dialog, getParent, isMainOrigin, requestClose, sendProgress}) {
  let progressEvent;

  function authorize(event) {
    if (!isMainOrigin(event)) throw new Error('无权执行此操作。');
  }

  async function confirm(parent, build, online) {
    const answer = await dialog.showMessageBox(parent, {
      type: 'question',
      title: '更新 HIVE',
      message: '更新到 ' + build.version,
      detail: '构建号 ' + build.buildNumber + '\n\n' +
        (online ? '将从 GitHub 下载更新。' : '请确认更新包来自可信来源。') +
        'HIVE 会先保存并退出，更新后自动重启。',
      buttons: [online ? '下载并更新' : '保存并更新', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return answer.response === 0;
  }

  async function apply(event) {
    authorize(event);
    const parent = getParent();
    if (!parent) return {status: 'cancelled'};
    const previousEvent = progressEvent;
    if (!progressEvent) progressEvent = event;
    let token;
    let handedOff = false;
    try {
      let result = await request('update-begin', {});
      token = result.token;
      if (result.status === 'picker') {
        const picked = await dialog.showOpenDialog(parent, {
          title: '选择 HIVE 更新清单',
          properties: ['openFile'],
          filters: [{name: 'HIVE 更新清单', extensions: ['json']}],
        });
        if (picked.canceled || picked.filePaths.length !== 1) return {status: 'cancelled'};
        result = await request('update-choice', {token, path: picked.filePaths[0]});
      }
      if (result.status !== 'confirm') return result;
      if (!await confirm(parent, result.build, result.online)) return {status: 'cancelled'};

      const staged = await request('update-stage', {token});
      if (staged.status !== 'ready') return staged;
      const closed = await requestClose(async () => {
        const started = await request('update-launch', {token, args: process.argv.slice(1)});
        if (started.status !== 'restarting') throw new Error(started.message || '无法启动更新程序。');
        handedOff = true;
      });
      if (closed) return {status: 'restarting'};
      return await request('update-cancel', {token, saveFailed: true});
    } catch (error) {
      return {status: 'error', message: error.message || '应用内更新失败，请稍后重试。'};
    } finally {
      if (token && !handedOff) await request('update-cancel', {token}).catch(() => {});
      if (!previousEvent && progressEvent === event) progressEvent = undefined;
    }
  }

  return {
    available(event) {
      authorize(event);
      return request('update-available', {});
    },
    setSource(event, source) {
      authorize(event);
      return request('update-source', {source});
    },
    progress(event) {
      authorize(event);
      return request('update-progress', {});
    },
    apply,
    markReady() {
      return request('update-ready', {});
    },
    onProgress(value) {
      if (progressEvent) sendProgress(progressEvent, value);
    },
  };
}

module.exports = {createUpdateBridge};
