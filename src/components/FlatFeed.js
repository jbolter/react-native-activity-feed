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

/**
 * Renders a feed of activities, this component is a StreamApp consumer
 * and must always be a child of the <StreamApp> element
 */
export default class FlatFeed extends React.Component<Props> {
  static defaultProps = {
    styles: {},
    feedGroup: 'timeline',
    notify: false,
    realtime: false,
    inverted: false,
    Activity: Activity,
    Notifier: NewActivitiesNotification,
  };

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

  refresh = () => {
      this.feedRef._refresh();
  }

  render() {
    return (
      <Feed
          feedGroup={this.props.feedGroup}
          userId={this.props.userId}
          options={this.props.options}
          notify={this.props.notify}
          realtime={this.props.realtime}
          inverted={this.props.inverted}
          maintainVisibleContentPosition={this.props.maintainVisibleContentPosition}
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
  _refresh = async () => {
    this._scrollToTop();
    await this.props.refresh(this.props.options);
    this._scrollToTop();
  };

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
      />
    );
  };

  _childProps = () => ({
    onToggleReaction: this.props.onToggleReaction,
    onAddReaction: this.props.onAddReaction,
    onRemoveReaction: this.props.onRemoveReaction,
    onToggleChildReaction: this.props.onToggleChildReaction,
    onAddChildReaction: this.props.onAddChildReaction,
    onRemoveChildReaction: this.props.onRemoveChildReaction,
    navigation: this.props.navigation,
    feedGroup: this.props.feedGroup,
    userId: this.props.userId,
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
              onScroll={this.props.onScroll}
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
