// Reanimated 驱动的 Pressable：长按进度类按钮（SOS）用它把 shared value 直接绑到样式上
import { Pressable } from 'react-native';
import Animated from 'react-native-reanimated';

export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
