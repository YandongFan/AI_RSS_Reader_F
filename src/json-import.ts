/** Opens a native JSON picker from a DOM-connected input for Electron compatibility. */
export function pickJsonFile(
  container: HTMLElement,
  onJson: (value: unknown) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const document = container.ownerDocument;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.style.display = 'none';

  const cleanup = (): void => input.remove();
  input.addEventListener('cancel', cleanup, { once: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) {
      cleanup();
      return;
    }
    void file.text()
      .then((raw) => JSON.parse(raw) as unknown)
      .then(onJson)
      .catch(onError)
      .finally(cleanup);
  }, { once: true });

  (document.body ?? document.documentElement).appendChild(input);
  input.click();
}
