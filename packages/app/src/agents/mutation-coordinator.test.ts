import { describe, expect, it } from "vitest";
import { SerializedOperationQueue } from "./mutation-coordinator";

describe("SerializedOperationQueue", () => {
  it("runs external-I/O operations one at a time in admission order", async () => {
    const queue = new SerializedOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
  });

  it("continues with the next operation after a rejection", async () => {
    const queue = new SerializedOperationQueue();

    await expect(queue.run(async () => {
      throw new Error("failed mutation");
    })).rejects.toThrow("failed mutation");

    await expect(queue.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
