// @flow
import * as React from 'react';
import { FlatList } from 'react-native';

import Activity from './Activity';
import NewActivitiesNotification from './NewActivitiesNotification';

import { Feed, FeedContext } from '../Context';
import { buildStylesheet } from '../styles';
import { smartRender } from '../utils';

import type {
  NavigationScreen,
  StyleSheetLike,
  BaseFeedCtx,
  BaseClient,
  Renderable,
} from '../types';
import type {
  FeedRequestOptions,
  FeedResponse,
  ActivityResponse,
} from 'getstream';

type Props = {|
  feedGroup: string,
  theme?: string,
  extraData?: any,
  userId?: string,
  /** read options for the API client (eg. limit, ranking, ...) */
  options?: FeedRequestOptions,
  Activity: Renderable,
  /** the component to use to render new activities notification */
  Notifier: Renderable,
  /** if true, feed shows the Notifier component when new activities are added */
  notify: boolean,
  /** if true, feed refreshes when new activities are received */
  realtime: boolean,
  /** if true, feed is inverted (transform-y) */
  inverted: boolean,
  /** maintainVisibleContentPosition prop for FlatList */
  maintainVisibleContentPosition: any,
  //** the element that renders the feed footer */
  Footer?: Renderable,
  //** the feed read hander (change only for advanced/complex use-cases) */
  doFeedRequest?: (
    client: BaseClient,
    feedGroup: string,
    userId?: string,
    options?: FeedRequestOptions,
  ) => Promise<FeedResponse<{}, {}>>,
  //** turns off pagination */
  noPagination?: boolean,
  analyticsLocation?: string,
  /** Underlying FlatList onScroll event **/
  onScroll?: () => mixed,
  onRefresh?: () => mixed,
  children?: React.Node,
  styles?: StyleSheetLike,
  navigation?: NavigationScreen,
  /** Any props the react native FlatList accepts */
  flatListProps?: {},
|};

const TOP_REACHED_THRESHOLD = 50;

/**
 * Renders a feed of activities, this component is a StreamApp consumer
 * and must always be a child of the <StreamApp> element
 */
export default class FlatFeed extends React.Component<Props> {
  static defaultProps = {
    extraData: {},
    styles: {},
    feedGroup: 'timeline',
    theme: '',
    notify: false,
    realtime: false,
    inverted: false,
    Activity: Activity,
    Notifier: NewActivitiesNotification,
  };

  loadReverseNextPage = async () => {
      if (this.feedRef._loadReverseNextPage) {
          await this.feedRef._loadReverseNextPage();
      }
  }

  loadNextPage = async () => {
      if (this.feedRef._loadNextPage) {
          await this.feedRef._loadNextPage();
      }
  }

  onAddReaction = (kind, activityId, data, targetFeeds) => {
      if (this.feedRef._onAddReaction) {
          this.feedRef._onAddReaction(kind, activityId, data, targetFeeds)
      }
  }

  onDeleteActivity = (kind, activity, reaction) => {
      if (this.feedRef._onDeleteActivity) {
          this.feedRef._onDeleteActivity(kind, activity, reaction)
      }
  }

  onDeleteReaction = (kind, activity, reaction) => {
      if (this.feedRef._onDeleteReaction) {
          this.feedRef._onDeleteReaction(kind, activity, reaction)
      }
  }

  onInsertActivities = (activities, indexToInsert) => {
      if (this.feedRef._onInsertActivities) {
          this.feedRef._onInsertActivities(activities, indexToInsert)
      }
  }

  onInsertReaction = (kind, activity, reaction, isOwn) => {
      if (this.feedRef._onInsertReaction) {
          this.feedRef._onInsertReaction(kind, activity, reaction, isOwn)
      }
  }

  onPinActivity = (activity) => {
      if (this.feedRef._onPinActivity) {
          this.feedRef._onPinActivity(activity)
      }
  }

  onUnpinActivity = (activity) => {
      if (this.feedRef._onUnpinActivity) {
          this.feedRef._onUnpinActivity(activity)
      }
  }

  onPinLiveActivity = (activity) => {
      if (this.feedRef._onPinLiveActivity) {
          this.feedRef._onPinLiveActivity(activity)
      }
  }

  onUnpinLiveActivity = (activity) => {
      if (this.feedRef._onUnpinLiveActivity) {
          this.feedRef._onUnpinLiveActivity(activity)
      }
  }

  onPromoteActivity = (activity) => {
      if (this.feedRef._onPromoteActivity) {
          this.feedRef._onPromoteActivity(activity)
      }
  }

  onUnpromoteActivity = (activity) => {
      if (this.feedRef._onUnpromoteActivity) {
          this.feedRef._onUnpromoteActivity(activity)
      }
  }

  scrollToActivity = (activityId) => {
      this.feedRef._scrollToActivity(activityId);
  }

  scrollToEnd = (animated = true) => {
      this.feedRef._scrollToEnd({animated: animated});
  }

  scrollToIndex = (options) => {
      if (this.feedRef && options) {
          this.feedRef._scrollToIndex(options);
      }
  }

  scrollToOffset = (options) => {
      if (this.feedRef && options) {
          this.feedRef._scrollToOffset(options);
      }
  }

  scrollToTop = () => {
      if (this.feedRef) {
          this.feedRef._scrollToTop();
      }
  }

  refresh = async () => {
      await this.feedRef._refresh();
  }

  render() {
    return (
      <Feed
          blockedUserIds={this.props.blockedUserIds}
          blockedByUserIds={this.props.blockedByUserIds}
          feedGroup={this.props.feedGroup}
          userId={this.props.userId}
          options={this.props.options}
          notify={this.props.notify}
          realtime={this.props.realtime}
          inverted={this.props.inverted}
          maintainVisibleContentPosition={this.props.maintainVisibleContentPosition}
          reactionListFeedGroup={this.props.reactionListFeedGroup}
          reactionListFeedId={this.props.reactionListFeedId}
          doFeedRequest={this.props.doFeedRequest}
      >
          <FeedContext.Consumer>
              {(feedCtx) => {
                  return <FlatFeedInner {...this.props} {...feedCtx} ref={r => this.feedRef = r} />;
              }}
          </FeedContext.Consumer>
      </Feed>
    );
  }
}

type PropsInner = {| ...Props, ...BaseFeedCtx |};
class FlatFeedInner extends React.Component<PropsInner> {
  listRef = React.createRef();

  _loadReverseNextPage = async () => {
      if (this.props.loadReverseNextPage) {
          await this.props.loadReverseNextPage();
      }
  }

  _loadNextPage = async () => {
      if (this.props.loadNextPage) {
          await this.props.loadNextPage();
      }
  }

  _refresh = async () => {
    this._scrollToTop();
    await this.props.refresh(this.props.options);
    this._scrollToTop();
  };

  _onAddReaction = (kind, activityId, data, targetFeeds) => {
      if (this.props.onAddReaction) {
          this.props.onAddReaction(kind, activityId, data, targetFeeds)
      }
  }

  _onDeleteActivity = (kind, activity, reaction) => {
      if (this.props.onDeleteActivity) {
          this.props.onDeleteActivity(kind, activity, reaction)
      }
  }

  _onDeleteReaction = (kind, activity, reaction) => {
      if (this.props.onDeleteReaction) {
          this.props.onDeleteReaction(kind, activity, reaction)
      }
  }

  _onInsertActivities = (activities, indexToInsert) => {
      if (this.props.onInsertActivities) {
          this.props.onInsertActivities(activities, indexToInsert)
      }
  }

  _onInsertReaction = (kind, activity, reaction, isOwn) => {
      if (this.props.onInsertReaction) {
          this.props.onInsertReaction(kind, activity, reaction, isOwn)
      }
  }

  _onPinActivity = (activity) => {
      if (this.props.onPinActivity) {
          this.props.onPinActivity(activity);
      }
  }

  _onUnpinActivity = (activity) => {
      if (this.props.onUnpinActivity) {
          this.props.onUnpinActivity(activity);
      }
  }

  _onPinLiveActivity = (activity) => {
      if (this.props.onPinLiveActivity) {
          this.props.onPinLiveActivity(activity);
      }
  }

  _onUnpinLiveActivity = (activity) => {
      if (this.props.onUnpinLiveActivity) {
          this.props.onUnpinLiveActivity(activity);
      }
  }

  _onPromoteActivity = (activity) => {
      if (this.props.onPromoteActivity) {
          this.props.onPromoteActivity(activity);
      }
  }

  _onUnpromoteActivity = (activity) => {
      if (this.props.onUnpromoteActivity) {
          this.props.onUnpromoteActivity(activity);
      }
  }

  _scrollToActivity = (activityId) => {
      let i = 0;
      for (activityOrderId of this.props.activityOrder) {
          if (activityOrderId === activityId) {
              break;
          }
          i++;
      }

      try {
          this._scrollToIndex({
              animated: true,
              index: i,
              viewOffset: -20,
              viewPosition: 1,
          })
      } catch (e) {
          console.log('scrollToActivity error', e);
      }
  }

  _scrollToEnd = (animated = true) => {
      let ref = this.listRef;
      if (ref && ref.current) {
        ref.current.scrollToEnd({animated: animated});
      }
  }

  _scrollToTop() {
    let ref = this.listRef;
    if (ref && ref.current) {
      ref.current.scrollToOffset({ offset: 0 });
    }
  }

  _scrollToIndex(options) {
    let ref = this.listRef;
    if (ref && ref.current) {
      ref.current.scrollToIndex(options);
    }
  }

  _scrollToOffset(options) {
    let ref = this.listRef;
    if (ref && ref.current) {
      ref.current.scrollToOffset(options);
    }
  }

  async componentDidMount() {
    await this._refresh();
  }

  _renderWrappedActivity = ({ item, index }: { item: any, index: number }) => {
    return (
      <ImmutableItemWrapper
          renderItem={this._renderActivity}
          item={item}
          index={index}
          navigation={this.props.navigation}
          feedGroup={this.props.feedGroup}
          userId={this.props.userId}
          theme={this.props.theme}
          extraData={this.props.extraData}
      />
    );
  };

  _childProps = () => ({
    onDeleteActivity: this.props.onDeleteActivity,
    onRemoveActivity: this.props.onRemoveActivity,
    onToggleReaction: this.props.onToggleReaction,
    onAddReaction: this.props.onAddReaction,
    onDeleteReaction: this.props.onDeleteReaction,
    onInsertActivities: this.props.onInsertActivities,
    onInsertReaction: this.props.onInsertReaction,
    onRemoveReaction: this.props.onRemoveReaction,
    onToggleChildReaction: this.props.onToggleChildReaction,
    onAddChildReaction: this.props.onAddChildReaction,
    onRemoveChildReaction: this.props.onRemoveChildReaction,
    navigation: this.props.navigation,
    feedGroup: this.props.feedGroup,
    userId: this.props.userId,
    hasNextPage: this.props.hasNextPage,
    hasReverseNextPage: this.props.hasReverseNextPage,
  });

  _renderActivity = (item: ActivityResponse<Object, Object>, index: number) => {
    let args = {
      activity: item,
      index: index,
      // $FlowFixMe
      styles: this.props.styles.activity,
      ...this._childProps(),
    };

    return smartRender(this.props.Activity, { ...args });
  };

  onScroll = (e) => {
      if (this.props.onScroll) {
          this.props.onScroll(e, this.props.hasNextPage, this.props.hasReverseNextPage);
      }

      // When "top" is reached (< TOP_REACHED_THRESHOLD), load previous page of data
      if (!this.props.noPagination && e.nativeEvent.contentOffset.y < TOP_REACHED_THRESHOLD && this.props.hasReverseNextPage) {
          this.props.loadReverseNextPage();
      }
  }

  render() {
    let styles = buildStylesheet('flatFeed', this.props.styles);
    let notifierProps = {
      adds: this.props.realtimeAdds,
      deletes: this.props.realtimeDeletes,
      onPress: this._refresh,
    };

    return (
      <React.Fragment>
          {smartRender(this.props.Notifier, notifierProps)}
          <FlatList
              inverted={this.props.inverted}
              maintainVisibleContentPosition={this.props.maintainVisibleContentPosition}
              ListHeaderComponent={this.props.children}
              style={styles.container}
              refreshing={this.props.refreshing}
              onRefresh={this.props.refresh}
              data={this.props.activityOrder.map((id) =>
                  this.props.activities.get(id),
              )}
              keyExtractor={(item) => item.get('id')}
              renderItem={this._renderWrappedActivity}
              onEndReached={
                  this.props.noPagination ? undefined : this.props.loadNextPage
              }
              onScroll={this.onScroll}
              ref={this.listRef}
              {...this.props.flatListProps}
          />
          {smartRender(this.props.Footer, this._childProps())}
      </React.Fragment>
    );
  }
}

type ImmutableItemWrapperProps = {
  renderItem: (item: any) => any,
  item: any,
};

class ImmutableItemWrapper extends React.PureComponent<
  ImmutableItemWrapperProps,
> {
  render() {
    return this.props.renderItem(this.props.item.toJS(), this.props.index);
  }
}
