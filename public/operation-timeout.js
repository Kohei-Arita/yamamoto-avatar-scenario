// SDKのPromise自体が返らない場合も、呼び出し側の監視を動かす。
// タイムアウトはSDK操作をキャンセルできないため、同じ接続で再試行してはいけない。
export function withOperationTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.requiresReconnect = true;
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
