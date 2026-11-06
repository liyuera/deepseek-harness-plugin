window.__ModuleLoader__.load({
  id: '@liyuera/dsh-bug-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@liyuera/dsh-bug-workflow';

    function BoardTab() {
      return h('div', {
        style: { padding: '16px', color: 'var(--dsw-alias-text-primary, inherit)', font: '13px/1.5 system-ui, sans-serif' },
      }, [
        h('div', { key: 'title', style: { fontWeight: 600 } }, 'Bug 工作流（P0 spike）'),
        h('div', { key: 'desc', style: { opacity: 0.7, marginTop: 8 } }, '右栏 tab 占座验证'),
      ]);
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: 'bug-board',
          title: () => 'Bug 看板',
          multiple: false,
          guide: [{ id: 'bug-board', order: 100, title: () => 'Bug 看板' }],
        }), 'bug-workflow: tab type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
        }, BoardTab)), 'bug-workflow: tab body');
      },
    };
  },
});
