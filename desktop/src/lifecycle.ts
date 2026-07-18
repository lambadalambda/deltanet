type QuitEffects = Readonly<{
  destroyWindow(): void;
  shutdown(): Promise<void>;
  complete(error: Error | null): void;
}>;

export const createQuitHandler = (effects: QuitEffects) => {
  let quitting = false;
  return (event: { preventDefault(): void }): void => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    effects.destroyWindow();
    void effects.shutdown().then(
      () => effects.complete(null),
      (error: unknown) => effects.complete(error instanceof Error ? error : new Error(String(error))),
    );
  };
};
