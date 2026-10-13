export class Fail extends Error {
  constructor(message) {
    super(message);
    this.name = 'Fail';
  }
}
