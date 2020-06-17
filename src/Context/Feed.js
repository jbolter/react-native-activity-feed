// @flow

import * as React from 'react';
import { Platform } from 'react-native';
import immutable from 'immutable';
import URL from 'url-parse';
import _ from 'lodash';
import type {
  FeedRequestOptions,
  FeedResponse,
  ReactionRequestOptions,
  ReactionFilterResponse,
  ReactionFilterOptions,
} from 'getstream';
import type {
  BaseActivityResponse,
  BaseAppCtx,
  BaseClient,
  BaseReaction,
  ToggleReactionCallbackFunction,
  AddReactionCallbackFunction,
  RemoveReactionCallbackFunction,
  ToggleChildReactionCallbackFunction,
  AddChildReactionCallbackFunction,
  RemoveChildReactionCallbackFunction,
} from '../types';
import { generateRandomId } from '../utils';
import isPlainObject from 'lodash/isPlainObject';

import type { AppCtx } from './StreamApp';
import { StreamApp } from './StreamApp';

import { sleep } from '../utils';

export const FeedContext = React.createContext({});

// type FR = FeedResponse<Object, Object>;
type FR = FeedResponse<{}, {}>;
type RR = ReactionFilterResponse<{}, {}>;
export type FeedCtx = {|
  feedGroup: string,
  userId?: string,
  activityOrder: Array<string>,
  activities: any,
  unread: number,
  unseen: number,
  refresh: (extraOptions?: FeedRequestOptions) => Promise<mixed>,
  refreshUnreadUnseen: () => Promise<mixed>,
  loadNextReactions: (
    activityId: string,
    kind: string,
    activityPath?: ?Array<string>,
    oldestToNewest?: boolean,
  ) => Promise<mixed>,
  loadNextPage: () => Promise<mixed>,
  hasNextPage: boolean,
  loadReverseNextPage: () => Promise<mixed>,
  hasReverseNextPage: boolean,
  refreshing: boolean,
  realtimeAdds: Array<{}>,
  realtimeDeletes: Array<{}>,
  onToggleReaction: ToggleReactionCallbackFunction,
  onAddReaction: AddReactionCallbackFunction,
  onRemoveReaction: RemoveReactionCallbackFunction,
  onToggleChildReaction: ToggleChildReactionCallbackFunction,
  onAddChildReaction: AddChildReactionCallbackFunction,
  onRemoveChildReaction: RemoveChildReactionCallbackFunction,
  onDeleteActivity: (activityId: string) => Promise<mixed>,
  onRemoveActivity: (activityId: string, kind: string) => Promise<mixed>,
  getActivityPath: (
    activity: BaseActivityResponse | string,
    ...Array<string>
  ) => Array<string>,
|};

export type FeedProps = {|
  feedGroup: string,
  userId?: string,
  options?: FeedRequestOptions,
  analyticsLocation?: string,
  notify?: boolean,
  realtime?: boolean,
  blockedUserIds?: any,
  blockedByUserIds?: any,
  reactionListFeedGroup?: string,
  reactionListFeedId?: string,
  inverted?: boolean,
  maintainVisibleContentPosition?: any,
  //** the feed read hander (change only for advanced/complex use-cases) */
  doFeedRequest?: (
    client: BaseClient,
    feedGroup: string,
    userId?: string,
    options?: FeedRequestOptions,
  ) => Promise<FeedResponse<{}, {}>>,
  children?: React.Node,
|};

type FeedManagerState = {|
  activityOrder: Array<string>,
  activities: any,
  refreshing: boolean,
  lastResponse: ?FR,
  lastReverseResponse: ?{ next: string },
  realtimeAdds: Array<{}>,
  realtimeDeletes: Array<{}>,
  subscription: ?any,
  activityIdToPath: { [string]: Array<string> },
  // activities created by creating a reaction with targetFeeds. It's a mapping
  // of a reaction id to an activity id.
  reactionActivities: { [string]: string },
  // Used for finding reposted activities
  activityIdToPaths: { [string]: Array<Array<string>> },
  reactionIdToPaths: { [string]: Array<Array<string>> },
  unread: number,
  unseen: number,
  numSubscribers: number,
  reactionsBeingToggled: { [kind: string]: { [activityId: string]: boolean } },
  childReactionsBeingToggled: {
    [kind: string]: { [reactionId: string]: boolean },
  },
|};

export class FeedManager {
  props: FeedInnerProps;
  state: FeedManagerState = {
    activityOrder: [],
    activities: immutable.Map(),
    activityIdToPath: {},
    activityIdToPaths: {},
    reactionIdToPaths: {},
    reactionActivities: {},
    lastResponse: null,
    lastReverseResponse: null,
    refreshing: false,
    realtimeAdds: [],
    realtimeDeletes: [],
    subscription: null,
    unread: 0,
    unseen: 0,
    numSubscribers: 0,
    reactionsBeingToggled: {},
    childReactionsBeingToggled: {},
  };
  registeredCallbacks: Array<() => mixed>;

  constructor(props: FeedInnerProps) {
    this.props = props;
    const initialOptions = this.getOptions();
    this.registeredCallbacks = [];
    let previousUrl = '';
    if (initialOptions.id_gte) {
      previousUrl = `?id_lt=${initialOptions.id_gte}`;
    } else if (initialOptions.id_gt) {
      previousUrl = `?id_lte=${initialOptions.id_gt}`;
    } else if (initialOptions.id_lte) {
      previousUrl = `?id_gt=${initialOptions.id_lte}`;
    } else if (initialOptions.id_lt) {
      previousUrl = `?id_gte=${initialOptions.id_lt}`;
    }
    this.state.lastReverseResponse = { next: previousUrl };

    this.insertedReactionIDs = new Set();
  }

  register(callback: () => mixed) {
    this.registeredCallbacks.push(callback);
    this.subscribe();
    // this.subscribeRealtime();
    this.subscribeReactions();
  }
  unregister(callback: () => mixed) {
    this.registeredCallbacks.splice(this.registeredCallbacks.indexOf(callback));
    this.unsubscribe();
    // this.unsubscribeRealtime();
    this.unsubscribeReactions();
  }

  triggerUpdate() {
    for (const callback of this.registeredCallbacks) {
      callback();
    }
  }

  setState = (
    changed:
      | $Shape<FeedManagerState>
      | ((FeedManagerState) => $Shape<FeedManagerState>),
  ) => {
    if (typeof changed === 'function') {
      changed = changed(this.state);
    }
    this.state = { ...this.state, ...changed };
    this.triggerUpdate();
  };

  trackAnalytics = (
    label: string,
    activity: BaseActivityResponse,
    track: ?boolean,
  ) => {
    const analyticsClient = this.props.analyticsClient;

    if (!track) {
      return;
    }
    if (!analyticsClient) {
      console.warn(
        'trackAnalytics was enabled, but analytics client was not initialized. ' +
          'Please set the analyticsToken prop on StreamApp',
      );
      return;
    }

    const feed = this.props.client.feed(
      this.props.feedGroup,
      this.props.userId,
    );

    analyticsClient.trackEngagement({
      label,
      feed_id: feed.id,
      content: {
        foreign_id: activity.foreign_id,
      },
      location: this.props.analyticsLocation,
    });
  };

  getActivityPath = (
    activity: BaseActivityResponse | string,
    ...rest: Array<string>
  ) => {
    let activityId;
    if (typeof activity === 'string') {
      activityId = activity;
    } else {
      activityId = activity.id;
    }

    const activityPath = this.state.activityIdToPath[activityId];
    if (activityPath === undefined) {
      return [activityId, ...rest];
    }
    return [...activityPath, ...rest];
  };

  getActivityPaths = (activity: BaseActivityResponse | string) => {
    let activityId;
    if (typeof activity === 'string') {
      activityId = activity;
    } else {
      activityId = activity.id;
    }

    return this.state.activityIdToPaths[activityId];
  };

  getReactionPaths = (reaction: BaseReaction | string) => {
    let reactionId;
    if (typeof reaction === 'string') {
      reactionId = reaction;
    } else {
      reactionId = reaction.id;
    }

    return this.state.reactionIdToPaths[reactionId];
  };

  onAddReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    data?: {},
    options: { trackAnalytics?: boolean } & ReactionRequestOptions = {},
  ) => {
    let reaction;
    try {
      reaction = await this.props.client.reactions.add(
        kind,
        activity,
        data,
        options,
      );
    } catch (e) {
      this.props.errorHandler(e, 'add-reaction', {
        kind,
        activity,
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    this.trackAnalytics(kind, activity, options.trackAnalytics);
    const enrichedReaction = immutable.fromJS({
      ...reaction,
      user: this.props.user.full,
    });

    if (this.insertedReactionIDs.has(reaction.id)) {
        return enrichedReaction.toJS();
    }

    // Healthline: Notify other feeds that this is happening
    // This is used to update the "parent" feed of a thread
    const eventData = {new: [{object: activity, reaction: reaction, verb: reaction.kind,}]};
    window.notificationEventBus.trigger('FEED_ACTIVITY_REACTIONS_LISTENER', eventData);

    this.insertedReactionIDs = new Set([...this.insertedReactionIDs, reaction.id]);

    this.setState((prevState) => {
      let { activities } = prevState;
      const { reactionIdToPaths } = prevState;
      for (const path of this.getActivityPaths(activity)) {
        this.removeFoundReactionIdPaths(
          activities.getIn(path).toJS(),
          reactionIdToPaths,
          path,
        );

        activities = activities
          .updateIn([...path, 'reaction_counts', kind], (v = 0) => v + 1)
          .updateIn([...path, 'own_reactions', kind], (v = immutable.List()) =>
            v.unshift(enrichedReaction),
          )
          .updateIn(
            [...path, 'latest_reactions', kind],
            (v = immutable.List()) => v.unshift(enrichedReaction),
          );

        this.addFoundReactionIdPaths(
          activities.getIn(path).toJS(),
          reactionIdToPaths,
          path,
        );
      }

      return { activities, reactionIdToPaths };
    });

    return enrichedReaction.toJS();
  };

  onInsertActivities = async (
      data: Array<{}>,
      indexToInsert?: number
  ) => {
      this.setState((prevState) => {
          let activityIDs = [];
          try {
              activityIDs = Object.keys(prevState.activities.toJS());
          } catch (e) {
              console.log(e);
          }

          const response = {
              results: data.filter(act => !activityIDs.includes(act.id)),
          }

          let activities = prevState.activities.merge(
              this.responseToActivityMap(response),
          );
          let activityIdToPath = {
              ...prevState.activityIdToPath,
              ...this.responseToActivityIdToPath(response),
          };

          const newActivityOrder = response.results.map((a) => a.id);

          let combinedActivityOrder;

          if (indexToInsert) {
              // Slice array from index to end
              const prevActivityOrder = prevState.activityOrder.slice(indexToInsert);
              // Slice array from start to index
              const prevActivityOrderFirstElems = prevState.activityOrder.slice(0, indexToInsert);
              // Insert activities at index
              combinedActivityOrder = prevActivityOrderFirstElems.concat(newActivityOrder.concat(prevActivityOrder));
          }
          else {
              // Add new activities to front of the array
              combinedActivityOrder = newActivityOrder.concat(prevState.activityOrder);
          }

          return {
              activityOrder: combinedActivityOrder,
              activities: activities,
              activityIdToPath: activityIdToPath,
              activityIdToPaths: this.responseToActivityIdToPaths(
                  response,
                  this.state.activityIdToPaths,
              ),
              reactionIdToPaths: this.feedResponseToReactionIdToPaths(
                  response,
                  this.state.reactionIdToPaths,
              ),
              reactionActivities: {
                  ...this.state.reactionActivities,
                  ...this.responseToReactionActivities(response),
              },
          };
      });
  };

  onPinActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          activities.valueSeq().forEach( v => {
              const act = v.toJS();
              for (const path of this.getActivityPaths(act)) {
                  if (act.id === activity.id) {
                      activities = activities.setIn([...path, 'is_pinned'], true)
                  }
                  else {
                      activities = activities.setIn([...path, 'is_pinned'], false)
                      activities = activities.setIn([...path, 'is_pinned_live'], false)
                  }
              }
          });

          return { activities };
      });
  };

  onUnpinActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          for (const path of this.getActivityPaths(activity)) {
              activities = activities.setIn([...path, 'is_pinned'], false)
          }

          return { activities };
      });
  };

  onPinLiveActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          activities.valueSeq().forEach( v => {
              const act = v.toJS();
              for (const path of this.getActivityPaths(act)) {
                  if (act.id === activity.id) {
                      activities = activities.setIn([...path, 'is_pinned_live'], true)
                  }
                  else {
                      activities = activities.setIn([...path, 'is_pinned'], false)
                      activities = activities.setIn([...path, 'is_pinned_live'], false)
                  }
              }
          });

          return { activities };
      });
  };

  onUnpinLiveActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          for (const path of this.getActivityPaths(activity)) {
              activities = activities.setIn([...path, 'is_pinned_live'], false)
          }

          return { activities };
      });
  };

  onPromoteActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          for (const path of this.getActivityPaths(activity)) {
              activities = activities.setIn([...path, 'tagged_for_email_digest'], true)
          }

          return { activities };
      });
  };

  onUnpromoteActivity = async (
      activity: BaseActivityResponse,
  ) => {
      this.setState((prevState) => {
          let { activities } = prevState;
          for (const path of this.getActivityPaths(activity)) {
              activities = activities.setIn([...path, 'tagged_for_email_digest'], false)
          }

          return { activities };
      });
  };

  onInsertReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    reaction: any,
    isOwn?: boolean,
  ) => {
    // this.trackAnalytics(kind, activity, options.trackAnalytics);
    const enrichedReaction = immutable.fromJS({
      ...reaction,
      user: reaction.user,
    });

    if (this.insertedReactionIDs.has(reaction.id)) {
        return;
    }

    this.insertedReactionIDs = new Set([...this.insertedReactionIDs, reaction.id]);

    this.setState((prevState) => {
      let { activities } = prevState;
      const { reactionIdToPaths } = prevState;
      const activityPaths = this.getActivityPaths(activity);
      if (activityPaths) {
          for (const path of activityPaths) {
            this.removeFoundReactionIdPaths(
              activities.getIn(path).toJS(),
              reactionIdToPaths,
              path,
            );

            activities = activities
              .updateIn([...path, 'reaction_counts', kind], (v = 0) => v + 1)
              .updateIn(
                [...path, 'latest_reactions', kind],
                (v = immutable.List()) => v.unshift(enrichedReaction),
              );

            if (isOwn) {
                activities = activities
                .updateIn([...path, 'own_reactions', kind], (v = immutable.List()) =>
                  v.unshift(enrichedReaction),
                );
            }



            this.addFoundReactionIdPaths(
              activities.getIn(path).toJS(),
              reactionIdToPaths,
              path,
            );
          }
      }

      return { activities, reactionIdToPaths };
    });
  };

  onRemoveReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    id: string,
    options: { trackAnalytics?: boolean } = {},
  ) => {
    try {
      await this.props.client.reactions.delete(id);
    } catch (e) {
      this.props.errorHandler(e, 'delete-reaction', {
        kind,
        activity,
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    this.trackAnalytics('un' + kind, activity, options.trackAnalytics);
    if (this.state.reactionActivities[id]) {
      this._removeActivityFromState(this.state.reactionActivities[id]);
    }

    const eventData = {deleted: [{object: activity, id: id, verb: kind,}]};

    // Healthline: Notify other feeds that this is happening
    // This is used to update the "parent" feed of a thread
    window.notificationEventBus.trigger('FEED_ACTIVITY_REACTIONS_LISTENER', eventData);

    return this.setState((prevState) => {
      let { activities } = prevState;
      const { reactionIdToPaths } = prevState;
      for (const path of this.getActivityPaths(activity)) {
        this.removeFoundReactionIdPaths(
          activities.getIn(path).toJS(),
          reactionIdToPaths,
          path,
        );

        activities = activities
          .updateIn([...path, 'reaction_counts', kind], (v = 0) => v - 1)
          .updateIn([...path, 'own_reactions', kind], (v = immutable.List()) =>
            v.remove(v.findIndex((r) => r.get('id') === id)),
          )
          .updateIn(
            [...path, 'latest_reactions', kind],
            (v = immutable.List()) =>
              v.remove(v.findIndex((r) => r.get('id') === id)),
          );

        this.addFoundReactionIdPaths(
          activities.getIn(path).toJS(),
          reactionIdToPaths,
          path,
        );
      }

      return { activities, reactionIdToPaths };
    });
  };

  onDeleteReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    id: string,
    options: { trackAnalytics?: boolean } = {},
  ) => {
    // this.trackAnalytics('un' + kind, activity, options.trackAnalytics);
    if (this.state.reactionActivities[id]) {
      this._removeActivityFromState(this.state.reactionActivities[id]);
    }

    return this.setState((prevState) => {
      let { activities } = prevState;
      const { reactionIdToPaths } = prevState;
      const activityPaths = this.getActivityPaths(activity);
      if (activityPaths) {
          for (const path of activityPaths) {
              this.removeFoundReactionIdPaths(
                  activities.getIn(path).toJS(),
                  reactionIdToPaths,
                  path,
              );

              activities = activities
                  .updateIn([...path, 'reaction_counts', kind], (v = 0) => v - 1)
                  .updateIn([...path, 'own_reactions', kind], (v = immutable.List()) =>
                  v.remove(v.findIndex((r) => r.get('id') === id)),
              )
              .updateIn(
                  [...path, 'latest_reactions', kind],
                  (v = immutable.List()) =>
                  v.remove(v.findIndex((r) => r.get('id') === id)),
              );

              this.addFoundReactionIdPaths(
                  activities.getIn(path).toJS(),
                  reactionIdToPaths,
                  path,
              );
          }
      }

      return { activities, reactionIdToPaths };
    });
  };

  onToggleReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    data: {},
    options: { trackAnalytics?: boolean } & ReactionRequestOptions = {},
  ) => {
    const togglingReactions = this.state.reactionsBeingToggled[kind] || {};
    if (togglingReactions[activity.id]) {
      return;
    }
    togglingReactions[activity.id] = true;
    this.state.reactionsBeingToggled[kind] = togglingReactions;

    const currentReactions = this.state.activities.getIn(
      [...this.getActivityPaths(activity)[0], 'own_reactions', kind],
      immutable.List(),
    );

    const last = currentReactions.last();
    let reaction;
    if (last) {
      await this.onRemoveReaction(kind, activity, last.get('id'), options);
    } else {
      reaction = await this.onAddReaction(kind, activity, data, options);
    }
    delete togglingReactions[activity.id];

    return reaction;
  };

  onAddChildReaction = async (
    kind: string,
    reaction: BaseReaction,
    data?: {},
    options: { trackAnalytics?: boolean } & ReactionRequestOptions = {},
  ) => {
    let childReaction;
    try {
      childReaction = await this.props.client.reactions.addChild(
        kind,
        reaction,
        data,
        options,
      );
    } catch (e) {
      this.props.errorHandler(e, 'add-child-reaction', {
        kind,
        reaction,
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }

    // this.trackAnalytics(kind, reaction, options.trackAnalytics);
    const enrichedReaction = immutable.fromJS({
      ...childReaction,
      user: this.props.user.full,
    });

    this.setState((prevState) => {
      let { activities } = prevState;
      for (const path of this.getReactionPaths(reaction)) {
        activities = activities
          .updateIn([...path, 'children_counts', kind], (v = 0) => v + 1)
          .updateIn([...path, 'own_children', kind], (v = immutable.List()) =>
            v.unshift(enrichedReaction),
          )
          .updateIn(
            [...path, 'latest_children', kind],
            (v = immutable.List()) => v.unshift(enrichedReaction),
          );
      }

      return { activities };
    });
  };

  onRemoveChildReaction = async (
    kind: string,
    reaction: BaseReaction,
    id: string,
    /* eslint-disable-next-line no-unused-vars */
    options: { trackAnalytics?: boolean } = {},
  ) => {
    try {
      await this.props.client.reactions.delete(id);
    } catch (e) {
      this.props.errorHandler(e, 'delete-reaction', {
        kind,
        reaction,
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    // this.trackAnalytics('un' + kind, reaction, options.trackAnalytics);
    if (this.state.reactionActivities[id]) {
      this._removeActivityFromState(this.state.reactionActivities[id]);
    }

    return this.setState((prevState) => {
      let { activities } = prevState;
      for (const path of this.getReactionPaths(reaction)) {
        activities = activities
          .updateIn([...path, 'children_counts', kind], (v = 0) => v - 1)
          .updateIn([...path, 'own_children', kind], (v = immutable.List()) =>
            v.remove(v.findIndex((r) => r.get('id') === id)),
          )
          .updateIn([...path, 'children', kind], (v = immutable.List()) =>
            v.remove(v.findIndex((r) => r.get('id') === id)),
          );
      }

      return { activities };
    });
  };

  onToggleChildReaction = async (
    kind: string,
    reaction: BaseReaction,
    data: {},
    options: { trackAnalytics?: boolean } & ReactionRequestOptions = {},
  ) => {
    const togglingReactions = this.state.childReactionsBeingToggled[kind] || {};
    if (togglingReactions[reaction.id]) {
      return;
    }
    togglingReactions[reaction.id] = true;
    this.state.childReactionsBeingToggled[kind] = togglingReactions;

    const currentReactions = this.state.activities.getIn(
      [...this.getReactionPaths(reaction)[0], 'own_children', kind],
      immutable.List(),
    );

    const last = currentReactions.last();
    if (last) {
      await this.onRemoveChildReaction(kind, reaction, last.get('id'), options);
    } else {
      await this.onAddChildReaction(kind, reaction, data, options);
    }
    delete togglingReactions[reaction.id];
  };
  _removeActivityFromState = (activityId: string) =>
    this.setState((prevState) => {
      const activities = prevState.activities.removeIn(
        this.getActivityPath(activityId),
        (v = 0) => v - 1,
      );
      const activityOrder = prevState.activityOrder.filter(
        (id) => id !== activityId,
      );
      return { activities, activityOrder };
    });

  onRemoveActivity = async (activityId: string) => {
    try {
      await this.feed().removeActivity(activityId);
    } catch (e) {
      this.props.errorHandler(e, 'delete-activity', {
        activityId: this.props.feedGroup,
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    return this._removeActivityFromState(activityId);
  };

  onDeleteActivity = (activityId: string) => {
    return this._removeActivityFromState(activityId);
  };

  getOptions = (extraOptions?: FeedRequestOptions = {}): FeedRequestOptions => {
    const propOpts = { ...this.props.options };
    const { id_gt, id_gte, id_lt, id_lte, offset } = extraOptions;
    if (id_gt || id_gte || id_lt || id_lte || offset != null) {
      delete propOpts.id_gt;
      delete propOpts.id_gte;
      delete propOpts.id_lt;
      delete propOpts.id_lte;
      delete propOpts.offset;
      delete propOpts.refresh;
    }

    return {
      withReactionCounts: true,
      withOwnReactions: true,
      limit: 10,
      ...propOpts,
      ...extraOptions,
    };
  };

  doFeedRequest = async (options: FeedRequestOptions): Promise<FR> => {
    const requestWasSentAt = Date.now();
    let response;

    if (this.props.doFeedRequest) {
      response = await this.props.doFeedRequest(
        this.props.client,
        this.props.feedGroup,
        this.props.userId,
        options,
      );
    } else {
      response = await this.feed().get(options);
    }
    if (Platform.OS === 'ios') {
      // Workaround for this issue: https://github.com/facebook/react-native/issues/5839
      const requestTime = Date.now() - requestWasSentAt;
      const MINIMUM_TIME_BETWEEN_REFRESHING_PROP_UPDATES = 350;
      const waitTime =
        MINIMUM_TIME_BETWEEN_REFRESHING_PROP_UPDATES - requestTime;
      if (waitTime > 0) {
        await sleep(waitTime);
      }
    }

    let { results } = response;

    try {
        const {blockedUserIds, blockedByUserIds} = this.props;
        // Remove blocked users
        let blockedOrBlockedByUserIds = (blockedUserIds && blockedUserIds.length) ? blockedUserIds : [];
        if (blockedByUserIds && blockedByUserIds.length) {
            blockedOrBlockedByUserIds = blockedOrBlockedByUserIds.concat(blockedByUserIds);
        }

        if ((blockedOrBlockedByUserIds && blockedOrBlockedByUserIds.length)) {
            var i = results.length
            while (i--) {
                // Get single activity or first activity in activity group
                const activity = (results[i]) ? (results[i].activities) ? results[i].activities[0] : results[i] : results[i];
                if (activity && activity.actor && blockedOrBlockedByUserIds.includes(activity.actor.id)) {
                    results.splice(i, 1);
                }
            }
        }
    } catch (error) {
        console.log('Error removing blocked users', error);
    }

    return response;
  };

  feed = () => this.props.client.feed(this.props.feedGroup, this.props.userId);

  responseToActivityMap = (response: FR) =>
    immutable.fromJS(
      response.results.reduce((map, a) => {
        map[a.id] = a;
        return map;
      }, {}),
    );

  responseToActivityIdToPath = (response: FR) => {
    if (
      response.results.length === 0 ||
      response.results[0].activities === undefined
    ) {
      return {};
    }
    const aggregatedResponse = (response: any);

    const map = {};
    for (const group of aggregatedResponse.results) {
      group.activities.forEach((act, i) => {
        map[act.id] = [group.id, 'activities', i];
      });
    }
    return map;
  };

  responseToActivityIdToPaths = (response: FR, previous: {} = {}) => {
    const map = previous;
    const currentPath = [];
    function addFoundActivities(obj) {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
          currentPath.push(i);
          addFoundActivities(v);
          currentPath.pop();
        });
      } else if (isPlainObject(obj)) {
        if (obj.id && obj.actor && obj.verb && obj.object) {
          if (!map[obj.id]) {
            map[obj.id] = [];
          }
          map[obj.id].push([...currentPath]);
        }
        for (const k in obj) {
          currentPath.push(k);
          addFoundActivities(obj[k]);
          currentPath.pop();
        }
      }
    }

    for (const a of response.results) {
      currentPath.push(a.id);
      addFoundActivities((a: any));
      currentPath.pop();
    }
    return map;
  };

  feedResponseToReactionIdToPaths = (response: FR, previous: {} = {}) => {
    const map = previous;
    const currentPath = [];
    function addFoundReactions(obj) {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
          currentPath.push(i);
          addFoundReactions(v);
          currentPath.pop();
        });
      } else if (isPlainObject(obj)) {
        if (obj.id && obj.kind && obj.data) {
          if (!map[obj.id]) {
            map[obj.id] = [];
          }
          map[obj.id].push([...currentPath]);
        }
        for (const k in obj) {
          currentPath.push(k);
          addFoundReactions(obj[k]);
          currentPath.pop();
        }
      }
    }

    for (const a of response.results) {
      currentPath.push(a.id);
      addFoundReactions((a: any));
      currentPath.pop();
    }
    return map;
  };

  reactionResponseToReactionIdToPaths = (
    response: RR,
    previous: {},
    basePath: $ReadOnlyArray<mixed>,
    oldLength: number,
  ) => {
    const map = previous;
    const currentPath = [...basePath];
    function addFoundReactions(obj) {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
          currentPath.push(i);
          addFoundReactions(v);
          currentPath.pop();
        });
      } else if (isPlainObject(obj)) {
        if (obj.id && obj.kind && obj.data) {
          if (!map[obj.id]) {
            map[obj.id] = [];
          }
          map[obj.id].push([...currentPath]);
        }
        for (const k in obj) {
          currentPath.push(k);
          addFoundReactions(obj[k]);
          currentPath.pop();
        }
      }
    }

    for (const a of response.results) {
      currentPath.push(oldLength);
      addFoundReactions((a: any));
      currentPath.pop();
      oldLength++;
    }
    return map;
  };

  removeFoundReactionIdPaths = (
    data: any,
    previous: {},
    basePath: $ReadOnlyArray<mixed>,
  ) => {
    const map = previous;
    const currentPath = [...basePath];
    function removeFoundReactions(obj) {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
          currentPath.push(i);
          removeFoundReactions(v);
          currentPath.pop();
        });
      } else if (isPlainObject(obj)) {
        if (obj.id && obj.kind && obj.data) {
          if (!map[obj.id]) {
            map[obj.id] = [];
          }
          _.remove(map[obj.id], (path) => _.isEqual(path, currentPath));
        }
        for (const k in obj) {
          currentPath.push(k);
          removeFoundReactions(obj[k]);
          currentPath.pop();
        }
      }
    }

    removeFoundReactions(data);
    return map;
  };

  addFoundReactionIdPaths = (
    data: any,
    previous: {},
    basePath: $ReadOnlyArray<mixed>,
  ) => {
    const map = previous;
    const currentPath = [...basePath];
    function addFoundReactions(obj) {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
          currentPath.push(i);
          addFoundReactions(v);
          currentPath.pop();
        });
      } else if (isPlainObject(obj)) {
        if (obj.id && obj.kind && obj.data) {
          if (!map[obj.id]) {
            map[obj.id] = [];
          }
          map[obj.id].push([...currentPath]);
        }
        for (const k in obj) {
          currentPath.push(k);
          addFoundReactions(obj[k]);
          currentPath.pop();
        }
      }
    }

    addFoundReactions(data);
    return map;
  };

  responseToReactionActivities = (response: FR) => {
    if (response.results.length === 0) {
      return {};
    }
    const map = {};
    function setReactionActivities(activities: any) {
      for (const a of activities) {
        if (a.reaction && a.reaction.id) {
          map[a.reaction.id] = a.id;
        }
      }
    }

    if (response.results[0].activities === undefined) {
      setReactionActivities(response.results);
    } else {
      const aggregatedResponse = (response: any);

      for (const group of aggregatedResponse.results) {
        setReactionActivities(group.activities);
      }
    }
    return map;
  };

  unseenUnreadFromResponse(response: FR) {
    let unseen = 0;
    let unread = 0;
    if (typeof response.unseen === 'number') {
      unseen = response.unseen;
    }
    if (typeof response.unread === 'number') {
      unread = response.unread;
    }
    return { unseen, unread };
  }

  refresh = async (extraOptions: FeedRequestOptions) => {
    const options = this.getOptions(extraOptions);

    await this.setState({ refreshing: true });
    let response: FR;
    try {
      response = await this.doFeedRequest(options);
    } catch (e) {
      this.setState({ refreshing: false });
      this.props.errorHandler(e, 'get-feed', {
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }

    const newState = {
      activityOrder: response.results.map((a) => a.id),
      activities: this.responseToActivityMap(response),
      activityIdToPath: this.responseToActivityIdToPath(response),
      activityIdToPaths: this.responseToActivityIdToPaths(response),
      reactionIdToPaths: this.feedResponseToReactionIdToPaths(response),
      reactionActivities: this.responseToReactionActivities(response),
      refreshing: false,
      lastResponse: response,
      realtimeAdds: [],
      realtimeDeletes: [],
      ...this.unseenUnreadFromResponse(response),
    };

    if (options.mark_seen === true) {
      newState.unseen = 0;
    }
    if (options.mark_read === true) {
      newState.unread = 0;
    }

    this.insertedReactionIDs = new Set();

    return this.setState(newState);
  };

  subscribe = async () => {
    if (this.props.notify) {
      const feed = this.feed();
      await this.setState((prevState) => {
        if (prevState.subscription) {
          return {};
        }
        const subscription = feed.subscribe((data) => {
          this.setState((prevState) => {
            const numActivityDiff = data.new.length - data.deleted.length;
            return {
              realtimeAdds: prevState.realtimeAdds.concat(data.new),
              realtimeDeletes: prevState.realtimeDeletes.concat(data.deleted),
              unread: prevState.unread + numActivityDiff,
              unseen: prevState.unseen + numActivityDiff,
            };
          });
        });

        subscription.then(
          () => {
            console.log(
              `now listening to changes in realtime for ${this.feed().id}`,
            );
          },
          (err) => {
            console.error(err);
          },
        );
        return { subscription };
      });
    }
  };

  subscribeRealtime = async () => {
     if (this.props.realtime) {
       let feed = this.feed();
       await this.setState((prevState) => {
         if (prevState.subscriptionRealtime) {
           return {};
         }
         let subscription = feed.subscribe((data) => {
           this.setState((prevState) => {
              const response = {
                 results: data.new,
             }

             let activities = prevState.activities.merge(
               this.responseToActivityMap(response),
             );
             let activityIdToPath = {
                 ...prevState.activityIdToPath,
               ...this.responseToActivityIdToPath(response),
             };

              const newActivityOrder = response.results.map((a) => a.id);

              return {
                 activityOrder: newActivityOrder.concat(prevState.activityOrder),
                 activities: activities,
                 activityIdToPath: activityIdToPath,
                 activityIdToPaths: this.responseToActivityIdToPaths(
                   response,
                   this.state.activityIdToPaths,
                 ),
                 reactionIdToPaths: this.feedResponseToReactionIdToPaths(
                   response,
                   this.state.reactionIdToPaths,
                 ),
                 reactionActivities: {
                   ...this.state.reactionActivities,
                   ...this.responseToReactionActivities(response),
                 },
             };
           });
         });

          subscription.then(
           () => {
             console.log(
               `now updating feed in realtime for ${this.feed().id}`,
             );
           },
           (err) => {
             console.error(err);
           },
         );
         return { subscriptionRealtime: subscription };
       });
     }
  };

  subscribeReactions = async () => {
      const activityId = this.props.reactionListFeedId;
      const {reactionListFeedGroup} = this.props;

     if (activityId && reactionListFeedGroup) {

         const reactionsFeed = this.props.client.feed(
           this.props.reactionListFeedGroup,
           this.props.reactionListFeedId,
         );

         await this.setState((prevState) => {
           if (prevState.subscriptionReactions) {
             return {};
           }

           let subscription = reactionsFeed.subscribe((data) => {
               if (data.new && data.new.length > 0) {

                   const {actor, reaction, verb} = data.new[0];

                   // Only add comments in realtime
                   if (verb !== 'comment') {
                       return;
                   }

                   const activity = {
                       id: reaction.activity_id,
                   }

                   // this.trackAnalytics(verb, activity, true);
                   const enrichedReaction = immutable.fromJS({
                       ...reaction,
                       user: actor,
                   });

                   this.setState((prevState) => {
                     let { activities } = prevState;
                     const { reactionIdToPaths } = prevState;
                     for (const path of this.getActivityPaths(activity)) {
                       this.removeFoundReactionIdPaths(
                         activities.getIn(path).toJS(),
                         reactionIdToPaths,
                         path,
                       );

                       activities = activities
                         .updateIn([...path, 'reaction_counts', verb], (v = 0) => v + 1)
                         .updateIn([...path, 'own_reactions', verb], (v = immutable.List()) =>
                           v.unshift(enrichedReaction),
                         )
                         .updateIn(
                           [...path, 'latest_reactions', verb],
                           (v = immutable.List()) => v.unshift(enrichedReaction),
                         );

                       this.addFoundReactionIdPaths(
                         activities.getIn(path).toJS(),
                         reactionIdToPaths,
                         path,
                       );
                     }

                     return { activities, reactionIdToPaths };
                   });
               }
           });

            subscription.then(
             () => {
               console.log(
                 `now updating feed for reactions for ${this.feed().id}`,
               );
             },
             (err) => {
               console.error(err);
             },
           );
           return { subscriptionReactions: subscription };
         });
     }
  }

  unsubscribe = async () => {
    const { subscription } = this.state;
    if (!subscription) {
      return;
    }
    await subscription;
    if (this.registeredCallbacks.length === 0) {
      try {
        await subscription.cancel();
        console.log(
          `stopped listening to changes in realtime for ${this.feed().id}`,
        );
      } catch (err) {
        console.error(err);
      }
    }
  };

  unsubscribeRealtime = async () => {
     let { subscriptionRealtime } = this.state;
     if (!subscriptionRealtime) {
       return;
     }
     await subscriptionRealtime;
     try {
         await subscriptionRealtime.cancel();
         console.log(
             `stopped listening to changes in realtime for ${this.feed().id}`,
         );
     } catch (err) {
         console.error(err);
     }
  };

  unsubscribeReactions = async () => {
     let { subscriptionReactions } = this.state;
     if (!subscriptionReactions) {
       return;
     }
     await subscriptionReactions;
     try {
         await subscriptionReactions.cancel();
         console.log(
             `stopped listening to changes in reactions for ${this.feed().id}`,
         );
     } catch (err) {
         console.error(err);
     }
  };

  hasNextPage = () => {
    const lastResponse = this.state.lastResponse;
    return Boolean(lastResponse && lastResponse.next);
  };

  hasReverseNextPage = () => {
    const { lastReverseResponse } = this.state;
    return Boolean(lastReverseResponse && lastReverseResponse.next);
  };

  loadNextPage = async () => {
    const lastResponse = this.state.lastResponse;
    if (!lastResponse || !lastResponse.next) {
      return;
    }
    let cancel = false;
    await this.setState((prevState) => {
      if (prevState.refreshing) {
        cancel = true;
        return {};
      }
      return { refreshing: true };
    });

    if (cancel) {
      return;
    }

    const nextURL = new URL(lastResponse.next, true);
    const options = this.getOptions(nextURL.query);

    let response: FR;
    try {
      response = await this.doFeedRequest(options);
    } catch (e) {
      this.setState({ refreshing: false });
      this.props.errorHandler(e, 'get-feed-next-page', {
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    return this.setState((prevState) => {
      const activities = prevState.activities.merge(
        this.responseToActivityMap(response),
      );
      const activityIdToPath = {
        ...prevState.activityIdToPath,
        ...this.responseToActivityIdToPath(response),
      };
      return {
        activityOrder: prevState.activityOrder.concat(
          response.results.map((a) => a.id),
        ),
        activities,
        activityIdToPath,
        activityIdToPaths: this.responseToActivityIdToPaths(
          response,
          prevState.activityIdToPaths,
        ),
        reactionIdToPaths: this.feedResponseToReactionIdToPaths(
          response,
          prevState.reactionIdToPaths,
        ),
        reactionActivities: {
          ...prevState.reactionActivities,
          ...this.responseToReactionActivities(response),
        },
        refreshing: false,
        lastResponse: response,
      };
    });
  };

  loadReverseNextPage = async () => {
    const { lastReverseResponse } = this.state;
    if (!lastReverseResponse || !lastReverseResponse.next) {
      return;
    }
    let cancel = false;
    await this.setState((prevState) => {
      if (prevState.refreshing) {
        cancel = true;
        return {};
      }
      return { refreshing: true };
    });

    if (cancel) {
      return;
    }

    const nextURL = new URL(lastReverseResponse.next, true);
    const options = this.getOptions(nextURL.query);

    let response: FR;
    try {
      response = await this.doFeedRequest(options);
    } catch (e) {
      this.setState({ refreshing: false });
      this.props.errorHandler(e, 'get-feed-next-page', {
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    return this.setState((prevState) => {
      const activities = prevState.activities.merge(
        this.responseToActivityMap(response),
      );
      const activityIdToPath = {
        ...prevState.activityIdToPath,
        ...this.responseToActivityIdToPath(response),
      };
      return {
        activityOrder: response.results
          .map((a) => a.id)
          .concat(prevState.activityOrder),
        activities,
        activityIdToPath,
        activityIdToPaths: this.responseToActivityIdToPaths(
          response,
          prevState.activityIdToPaths,
        ),
        reactionIdToPaths: this.feedResponseToReactionIdToPaths(
          response,
          prevState.reactionIdToPaths,
        ),
        reactionActivities: {
          ...prevState.reactionActivities,
          ...this.responseToReactionActivities(response),
        },
        refreshing: false,
        lastReverseResponse: response,
      };
    });
  };

  loadNextReactions = async (
    activityId: string,
    kind: string,
    activityPath?: ?Array<string>,
    oldestToNewest?: boolean,
  ) => {
    let options: ReactionFilterOptions = {
      activity_id: activityId,
      kind,
    };

    let orderPrefix = 'latest';
    if (oldestToNewest) {
      orderPrefix = 'oldest';
    }

    if (!activityPath) {
      activityPath = this.getActivityPath(activityId);
    }
    const latestReactionsPath = [
      ...activityPath,
      orderPrefix + '_reactions',
      kind,
    ];
    const nextUrlPath = [
      ...activityPath,
      orderPrefix + '_reactions_extra',
      kind,
      'next',
    ];
    const refreshingPath = [
      ...activityPath,
      orderPrefix + '_reactions_extra',
      kind,
      'refreshing',
    ];

    const reactions_extra = this.state.activities.getIn([
      ...activityPath,
      orderPrefix + '_reactions_extra',
    ]);
    let nextUrl = 'https://api.stream-io-api.com/';
    if (reactions_extra) {
      nextUrl = reactions_extra.getIn([kind, 'next'], '');
    } else if (oldestToNewest) {
      // If it's the first request and oldest to newest make sure
      // order is reversed by this trick with a non existant id.
      options.id_gt = 'non-existant-' + generateRandomId();
    }

    // Load 100 comments at a time
    // options.limit = 100;


    const refreshing = this.state.activities.getIn(refreshingPath, false);

    if (!nextUrl || refreshing) {
      return;
    }

    this.setState((prevState) => ({
      activities: prevState.activities.setIn(refreshingPath, true),
    }));

    options = {
      ...URL(nextUrl, true).query,
      ...options,
    };

    let response;
    try {
      response = await this.props.client.reactions.filter(options);
    } catch (e) {
      this.setState({ refreshing: false });
      this.props.errorHandler(e, 'get-reactions-next-page', {
        options,
      });
      return;
    }
    this.setState((prevState) => ({
      activities: prevState.activities
        .setIn(refreshingPath, false)
        .setIn(nextUrlPath, response.next)
        .updateIn(latestReactionsPath, (v = immutable.List()) =>
          v.concat(immutable.fromJS(response.results)),
        ),
      reactionIdToPaths: this.reactionResponseToReactionIdToPaths(
        response,
        prevState.reactionIdToPaths,
        latestReactionsPath,
        prevState.activities.getIn(latestReactionsPath, immutable.List()).toJS()
          .length,
      ),
    }));
  };

  refreshUnreadUnseen = async () => {
    let response: FR;
    try {
      response = await this.doFeedRequest({ limit: 1 });
    } catch (e) {
      this.props.errorHandler(e, 'get-notification-counts', {
        feedGroup: this.props.feedGroup,
        userId: this.props.userId,
      });
      return;
    }
    return this.setState(this.unseenUnreadFromResponse(response));
  };
}

type FeedState = {|
  manager: FeedManager,
|};

export class Feed extends React.Component<FeedProps, FeedState> {
  // Used to avoid unmount-remount behaviour, which causes
  // unsubscribe-subscribe behaviour.
  _appCtxWrapperFunc = (appCtx: AppCtx<any>) => (
    <FeedInner {...this.props} {...appCtx} />
  );

  render() {
    return <StreamApp.Consumer>{this._appCtxWrapperFunc}</StreamApp.Consumer>;
  }
}

type FeedInnerProps = {| ...FeedProps, ...BaseAppCtx |};
class FeedInner extends React.Component<FeedInnerProps, FeedState> {
  constructor(props: FeedInnerProps) {
    super(props);
    const feedId = props.client.feed(props.feedGroup, props.userId).id;
    let manager = props.sharedFeedManagers[feedId];
    if (!manager) {
      manager = new FeedManager(props);
    }

    this.state = {
      manager,
    };
  }
  boundForceUpdate = () => this.forceUpdate();

  componentDidMount() {
    return this.state.manager.register(this.boundForceUpdate);
  }

  componentDidUpdate(prevProps) {
    const clientDifferent = this.props.client !== prevProps.client;
    const notifyDifferent = this.props.notify !== prevProps.notify;
    const feedDifferent =
      this.props.userId !== prevProps.userId ||
      this.props.feedGroup !== prevProps.feedGroup;
    const optionsDifferent = !_.isEqual(this.props.options, prevProps.options);
    const doFeedRequestDifferent = this.props.doFeedRequest !== prevProps.doFeedRequest;

      // Update "next" page URL
      if (optionsDifferent) {
          let previousUrl = '';
          if (this.props.options.id_gte) {
            previousUrl = `?id_lt=${this.props.options.id_gte}`;
          } else if (this.props.options.id_gt) {
            previousUrl = `?id_lte=${this.props.options.id_gt}`;
          } else if (this.props.options.id_lte) {
            previousUrl = `?id_gt=${this.props.options.id_lte}`;
          } else if (this.props.options.id_lt) {
            previousUrl = `?id_gte=${this.props.options.id_lt}`;
          }
          this.state.manager.state.lastReverseResponse = { ...this.state.manager.state.lastReverseResponse, next: previousUrl };
      }

    if (
      clientDifferent ||
      feedDifferent ||
      optionsDifferent ||
      doFeedRequestDifferent
    ) {
      // TODO: Implement
    }
    if (clientDifferent || feedDifferent || notifyDifferent) {
      // TODO: Implement
    }
  }

  componentWillUnmount() {
    return this.state.manager.unregister(this.boundForceUpdate);
  }

  getCtx = () => {
    const { manager } = this.state;
    const state = manager.state;
    return {
      getActivityPath: manager.getActivityPath,
      onToggleReaction: manager.onToggleReaction,
      onAddReaction: manager.onAddReaction,
      onDeleteReaction: manager.onDeleteReaction,
      onInsertActivities: manager.onInsertActivities,
      onInsertReaction: manager.onInsertReaction,
      onPinActivity: manager.onPinActivity,
      onPinLiveActivity: manager.onPinLiveActivity,
      onUnpinActivity: manager.onUnpinActivity,
      onUnpinLiveActivity: manager.onUnpinLiveActivity,
      onPromoteActivity: manager.onPromoteActivity,
      onUnpromoteActivity: manager.onUnpromoteActivity,
      onRemoveReaction: manager.onRemoveReaction,
      onToggleChildReaction: manager.onToggleChildReaction,
      onAddChildReaction: manager.onAddChildReaction,
      onRemoveChildReaction: manager.onRemoveChildReaction,
      onDeleteActivity: manager.onDeleteActivity,
      onRemoveActivity: manager.onRemoveActivity,
      refresh: manager.refresh,
      refreshUnreadUnseen: manager.refreshUnreadUnseen,
      loadNextReactions: manager.loadNextReactions,
      loadNextPage: manager.loadNextPage,
      hasNextPage: manager.hasNextPage(),
      loadReverseNextPage: manager.loadReverseNextPage,
      hasReverseNextPage: manager.hasReverseNextPage(),
      feedGroup: this.props.feedGroup,
      userId: this.props.userId,
      activityOrder: state.activityOrder,
      activities: state.activities,
      realtimeAdds: state.realtimeAdds,
      realtimeDeletes: state.realtimeDeletes,
      refreshing: state.refreshing,
      unread: state.unread,
      unseen: state.unseen,
    };
  };

  render() {
    return (
      <FeedContext.Provider value={this.getCtx()}>
        {this.props.children}
      </FeedContext.Provider>
    );
  }
}
