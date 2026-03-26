export interface EventPipelineRequest<TInput, TAuth, TEvent, TPersisted> {
  input: TInput;
  validate(input: TInput): Promise<void> | void;
  resolveAuth(input: TInput): Promise<TAuth> | TAuth;
  authorize(input: TInput, auth: TAuth): Promise<void> | void;
  buildEvent(input: TInput, auth: TAuth): Promise<TEvent> | TEvent;
  persist(input: TInput, auth: TAuth, event: TEvent): Promise<TPersisted> | TPersisted;
  fanout?(input: TInput, auth: TAuth, event: TEvent, persisted: TPersisted): Promise<void> | void;
  notifyFederation?(
    input: TInput,
    auth: TAuth,
    event: TEvent,
    persisted: TPersisted
  ): Promise<void> | void;
}

export interface EventPipelinePostCommitError {
  stage: 'fanout' | 'notifyFederation';
  error: unknown;
}

export interface EventPipelineResult<TAuth, TEvent, TPersisted> {
  auth: TAuth;
  event: TEvent;
  persisted: TPersisted;
  trace: string[];
  postCommitErrors: EventPipelinePostCommitError[];
}

export interface EventPipeline {
  execute<TInput, TAuth, TEvent, TPersisted>(
    request: EventPipelineRequest<TInput, TAuth, TEvent, TPersisted>
  ): Promise<EventPipelineResult<TAuth, TEvent, TPersisted>>;
}

export class DefaultEventPipeline implements EventPipeline {
  async execute<TInput, TAuth, TEvent, TPersisted>(
    request: EventPipelineRequest<TInput, TAuth, TEvent, TPersisted>
  ): Promise<EventPipelineResult<TAuth, TEvent, TPersisted>> {
    const trace: string[] = [];
    const postCommitErrors: EventPipelinePostCommitError[] = [];

    trace.push('validate');
    await request.validate(request.input);

    trace.push('resolveAuth');
    const auth = await request.resolveAuth(request.input);

    trace.push('authorize');
    await request.authorize(request.input, auth);

    trace.push('buildEvent');
    const event = await request.buildEvent(request.input, auth);

    trace.push('persist');
    const persisted = await request.persist(request.input, auth, event);

    if (request.fanout) {
      trace.push('fanout');
      try {
        await request.fanout(request.input, auth, event, persisted);
      } catch (error) {
        postCommitErrors.push({ stage: 'fanout', error });
      }
    }

    if (request.notifyFederation) {
      trace.push('notifyFederation');
      try {
        await request.notifyFederation(request.input, auth, event, persisted);
      } catch (error) {
        postCommitErrors.push({ stage: 'notifyFederation', error });
      }
    }

    return {
      auth,
      event,
      persisted,
      trace,
      postCommitErrors,
    };
  }
}

