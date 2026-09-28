export function browserActivity(view, parent, activate) {
  const content = view.webContents;
  let presented = false;
  let attached = false;
  let operations = 0;
  let idle;
  let disposed = false;
  let focused = false;
  let activation = Promise.resolve();
  const focus = value => {
    if (value === focused) return activation;
    focused = value;
    activation = activation.catch(() => {}).then(() => {
      if (!disposed && !content.isDestroyed()) return activate(value);
    });
    return activation;
  };
  const update = () => {
    if (disposed || content.isDestroyed()) return;
    const active = operations > 0 || idle !== undefined;
    const needed = presented || active;
    if (needed !== attached) {
      if (needed) {
        parent.addChildView(view);
        view.setVisible(true);
      } else parent.removeChildView(view);
      attached = needed;
    }
    void focus(needed).catch(() => {});
  };
  return {
    present(value) {
      presented = value;
      update();
    },
    async run(operation) {
      if (disposed || content.isDestroyed()) throw new Error("This browser tab is closed");
      clearTimeout(idle);
      idle = undefined;
      operations++;
      try {
        update();
        await activation;
        if (disposed || content.isDestroyed()) throw new Error("This browser tab is closed");
        return await operation();
      } finally {
        operations--;
        if (!disposed && !content.isDestroyed() && operations === 0) {
          idle = setTimeout(() => {
            idle = undefined;
            update();
          }, 30_000);
          idle.unref();
        }
        update();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(idle);
      idle = undefined;
    },
  };
}
