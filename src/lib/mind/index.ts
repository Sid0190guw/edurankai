// src/lib/mind/index.ts — AquinTutor's own intelligence, in one import.
//
// The shape of the thing, for anyone arriving here first:
//
//   features.ts  a lived moment -> numbers, plus the incumbent estimator every model must beat
//   nn.ts        the network: forward, backpropagation, Adam, saliency, JSON in and out
//   cluster.ts   unsupervised structure — the groups nobody labelled
//   semisup.ts   self-training on abandoned work, and label propagation across concepts
//   evaluate.ts  metrics, the held-out split, and the promotion gate that is allowed to say no
//   store.ts     the corpus, the checkpoints, the runs, the human corrections
//   train.ts     one full cycle: read, discover, replay, train, judge, promote or shelve
//   serve.ts     answering, always with a fallback and always with an explanation
//   distill.ts   a pretrained model as a TEACHER, never as a dependency
export * from './features';
export * from './nn';
export * from './cluster';
export * from './semisup';
export * from './evaluate';
export * from './store';
export * from './train';
export * from './serve';
export * from './distill';
