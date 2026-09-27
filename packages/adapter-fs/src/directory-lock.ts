interface DirectoryMutationLock {
  tail: Promise<void>;
  leases: number;
}

// Resolving a parent and mutating a child must be one critical section: otherwise a
// concurrent prune can remove that parent and let a replacement redirect the pathname, or
// remove a directory another write found in place before it put its file there.
// The map is shared by every storage in this process that resolves to the same root.
const directoryMutationLocks = new Map<string, DirectoryMutationLock>();
const doNothing = (): void => {};

export async function holdDirectoryMutations(realRoot: string): Promise<() => void> {
  const lock = directoryMutationLocks.get(realRoot) ?? {
    tail: Promise.resolve(),
    leases: 0,
  };
  const previous = lock.tail;
  let releaseNext = doNothing;

  lock.tail = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  lock.leases += 1;
  directoryMutationLocks.set(realRoot, lock);

  await previous;

  let held = true;

  return () => {
    if (!held) return;

    held = false;
    lock.leases -= 1;
    releaseNext();

    if (lock.leases === 0 && directoryMutationLocks.get(realRoot) === lock) {
      directoryMutationLocks.delete(realRoot);
    }
  };
}

/** Runs the step with no directory below the root created or removed by anyone else. */
export async function withDirectoryMutations<T>(
  realRoot: string,
  step: () => Promise<T>,
): Promise<T> {
  const release = await holdDirectoryMutations(realRoot);

  try {
    return await step();
  } finally {
    release();
  }
}
