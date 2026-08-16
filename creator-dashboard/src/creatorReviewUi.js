export function canAcceptReviewCase(reviewCase) {
  return reviewCase?.status === "needs_review" && reviewCase?.verdict === "PASS";
}

export function completeReviewMode(review) {
  if (review?.rerun_ready) return "rerun";
  if (review?.release_ready) return "publish";
  return "review";
}
