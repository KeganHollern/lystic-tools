/** Short english ids: brave-apple, quiet-cedar, … */

const ADJ = [
  "amber", "brave", "calm", "crisp", "eager", "fair", "gentle", "happy",
  "jolly", "keen", "lucky", "merry", "noble", "proud", "quick", "rapid",
  "sunny", "tidy", "vivid", "warm", "zesty", "bold", "clear", "daring",
  "earnest", "fancy", "glad", "honest", "ivory", "jazzy",
];

const NOUN = [
  "apple", "brook", "cedar", "daisy", "ember", "finch", "grove", "haven",
  "iris", "jade", "kite", "lotus", "maple", "nova", "olive", "pebble",
  "quill", "river", "stone", "tide", "umbra", "vale", "willow", "yarn",
  "zephyr", "acorn", "basil", "coral", "delta", "flint",
];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)]!;
}

export function allocWordId(taken: Set<string>): string {
  for (let i = 0; i < 80; i++) {
    const id = `${pick(ADJ)}-${pick(NOUN)}`;
    if (!taken.has(id)) return id;
  }
  return `${pick(ADJ)}-${pick(NOUN)}-${Math.floor(Math.random() * 90 + 10)}`;
}
