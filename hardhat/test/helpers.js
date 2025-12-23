export function decodeReceiptEvents(receipt, iface) {
  return receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function expectRevert(promise, includesText) {
  try {
    await promise;
  } catch (e) {
    const msg = (e?.shortMessage || e?.message || "").toString();
    if (!msg.includes(includesText)) {
      throw new Error(`Expected revert including '${includesText}', got: ${msg}`);
    }
    return;
  }
  throw new Error(`Expected revert including '${includesText}', but tx succeeded`);
}


