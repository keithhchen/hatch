/** The page `/link/im?t=<token>`: a person who messaged an IM bot signs in here, and the bot's chat becomes theirs. */
export const IM_LINK_PATH = "/link/im";

const FAILURES = Object.freeze({
  im_link_invalid: "invalid",
  im_link_expired: "expired",
  im_already_linked: "alreadyLinked",
  library_unavailable: "unavailable"
});

/**
 * The state the page is in, from what the claim answered:
 * `linked` (with the Agent to open), `invalid`, `expired`, `alreadyLinked`, or `unavailable` (retryable, so is anything unexpected).
 */
export async function claimImLink(request, search) {
  const token = new URLSearchParams(search).get("t");
  if (!token) return { status: "invalid" };
  try {
    const { product_id: productId } = await request("/v1/im-link/claim", { method: "POST", body: JSON.stringify({ token }) });
    return { status: "linked", productId };
  } catch (error) {
    return { status: FAILURES[error?.code] ?? "unavailable" };
  }
}
