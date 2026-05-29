// Temporary fixture to smoke-test the review bot. Safe to delete.
function classify(value: number): string {
  let result: string;
  if (value > 0) {
    if (value > 100) {
      result = 'big';
    } else {
      result = 'small';
    }
  } else {
    result = 'nonpositive';
  }
  return result;
}

export default classify;
