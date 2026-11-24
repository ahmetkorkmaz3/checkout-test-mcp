// Source fixture for the inspect_target code scan. It is not the code of the running demo store.
export function CheckoutPage() {
  return (
    <main>
      <h1>Checkout</h1>
      <label>
        <input type="checkbox" data-testid="terms" /> I accept the terms
      </label>
      <button type="button" data-testid="pay-button">
        Pay now
      </button>
    </main>
  );
}
