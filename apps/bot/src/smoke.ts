// Temporary fixture to smoke-test the review bot. Safe to delete.
function classify(value: number): string {
  if (value > 0) {
    if (value > 100) {
      return 'big';
    }

    return 'small';
  }

  return 'nonpositive';
}

export default classify;
