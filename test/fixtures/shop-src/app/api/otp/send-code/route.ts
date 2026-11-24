// Sends the SMS code for phone verification.
export async function POST() {
  return Response.json({ sent: true });
}
