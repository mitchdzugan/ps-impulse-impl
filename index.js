"use strict";
let lock = { then: f => f() };
let releaseLock = () => {};
const takeLock = () => {
	lock = new Promise(resolve => { releaseLock = resolve; lock = { then: f => f() }; });
};

const makeEvent = (on = () => () => {}) => {
	// TODO
	// maybe use this for a perf optimization
	// unused for now for simplicity
	// let isDone = false;
	// TODO
	// maybe use this to allow clients to
	// handle errors how they wish. Unused
	// for now for simplicity.
	// let error = undefined;
	let nextSubId = 0;
	let ons = new Set();
	let subs = {};

	const clear = () => {
		ons = new Set();
		subs = {};
	};

	const listen = (f) => {
		const subId = nextSubId++;
		subs[subId] = f;
		return () => {
			const off = on();
			ons.add(subId);
			subs[subId] = f;
			return () => {
				off();
				ons.delete(subId);
				delete subs[subId];
			};
		};
	};
	const consume = f => listen(f)();
	const push = (a) => {
		ons.forEach(id => subs[id](a));
	};

	const helper = (f) => {
		let e = { push: () => {} };
		let onCount = 0;
		let off = () => {};
		const on = listen(v => f(v, e.push));
		e = makeEvent(() => {
			if (!onCount) {
				off = on();
			}
			onCount++;
			return () => {
				onCount--;
				if (!onCount) {
					off();
				}
			};
		});
		return e;
	};

	const fmap = f => helper((v, push) => push(f(v)));
	const filter = f => helper((v, push) => f(v) && push(v));
	const reduce = (f, init) => {
		let acc = init;
		return helper((v, push) => {
			acc = f(acc)(v);
			push(acc);
		});
	};
	const flatMap = (f) => {
		let e = { push: () => {} };
		let onCount = 0;
		let innerOff = () => {};
		let innerOn = () => () => {};
		let outerOff = () => {};
		const outerOn = listen(inner => {
			const isConsuming = onCount > 0;
			if (isConsuming) {
				innerOff();
			}
			const ires = f(inner);
			// TODO what the actual fuck
			innerOn = ires.listen && ires.listen(v => e.push(v));
			if (isConsuming) {
				innerOff = innerOn ? innerOn() : (() => {});
			}
		});
		e = makeEvent(() => {
			if (!onCount) {
				outerOff = outerOn();
				innerOff = innerOn();
			}
			onCount++;
			return () => {
				onCount--;
				if (!onCount) {
					innerOff();
					outerOff();
				}
			};
		});
		return e;
	};

	return {
		listen,
		consume,
		push,
		fmap,
		filter,
		reduce,
		flatMap,
		clear,
		mapEff: helper
	};
};

const adaptEvent = (sub, unsub) => {
	let e = { push: () => {} };
	let onCount = 0;
	let subRes;
	e = makeEvent(() => {
		if (!onCount) {
			subRes = sub(v => e.push(v));
		}
		onCount++;
		return () => {
			onCount--;
			if (!onCount) {
				unsub(subRes);
			}
		};
	});
	return e;
};

const joinEvents = (...events) => {
	let e = { push: () => {} };
	let onCount = 0;
	let offs = [];
	const ons = events.map(inner => inner.listen(v => e.push(v)));
	e = makeEvent(() => {
		if (!onCount) {
			offs = ons.map(on => on());
		}
		onCount++;
		return () => {
			onCount--;
			if (!onCount) {
				offs.forEach(off => off());
			}
		};
	});
	return e;
};

let nextSigId = 0
const makeSignal = (event, init) => {
	const sigId = nextSigId++;
	let nextConsId = 1;
	let cons = {};
	let onCount = 0;
	let off = () => false;
	let val = init;


	const stateful = { res: {} };

	const changed = event
		.fmap(v => {
			if (onCount === 0) {
				return { skip: true };
			}
			if (val == v || val === v) {
				return { skip: true };
			}
			val = v;
			return { val: v };
		})
				.filter(({ skip }) => {
					if (onCount === 0 && !skip) {
						console.log('isReallyBad');
					}
					return !skip ;
				})
		.fmap(({ val }) => val);

	let unwrappedOff = () => {};
	const masterCons = val => {
		Object.values(cons).forEach(f => f(val));
	};
	const consume = (f) => {
		const consId = nextConsId++;
		cons[consId] = f;
		onCount += 1;
		const res = f(val);
		// console.log({ onCount, sigId, consId });
		if (onCount === 1) {
			// console.log('on!!', { onCount, sigId, consId });
			unwrappedOff = changed.consume(masterCons);
		}
		off = () => {
			onCount -= 1;
			delete cons[consId];
			// console.log({ onCount, sigId, consId });
			if (onCount === 0) {
				// console.log('off!!', { onCount, sigId, consId });
				unwrappedOff();
				return true;
			}
			return false;
		};
		return { res, off };
	};

	const getVal = () => val;
	const tagEvent = e => e.fmap(() => val);
	const dedup = (areEq) => (
		makeSignal(
			changed
				.reduce(
					({ prev }) => curr => (
						areEq(prev, curr) ? { skip: true, prev } : { curr, prev: curr }
					),
					{ prev: val },
				)
				.filter(({ skip }) => !skip)
				.fmap(({ curr }) => curr),
			val,
		)
	);
	const fmap = (f) => makeSignal(changed.fmap(f), f(val));
	const flatMap = (fs) => {
		const initS = fs(val);
		const init = initS.getVal();
		const initChanged = initS.changed;
		const changes = changed.fmap(inner => fs(inner).getVal());
		const updates = changed.flatMap(inner => fs(inner).changed);
		const event = joinEvents(initChanged, changes, updates);
		return makeSignal(event, init);
	};

	consume(() => {});
	stateful.res = {
		off,
		consume,
		getVal,
		changed,
		tagEvent,
		dedup,
		fmap,
		flatMap,
	};
	return stateful.res;
};

const zipWith = (f, ...signals) => {
	const getVal = () => f(...signals.map(s => s.getVal()));
	const event = joinEvents(...signals.map(s => s.changed)).fmap(getVal);
	return makeSignal(event, getVal());
};

exports.makeEvent = makeEvent;
exports.makeSignal = makeSignal;
exports.joinEvents = joinEvents;
exports.adaptEvent = adaptEvent;
exports.zipWith = zipWith;
